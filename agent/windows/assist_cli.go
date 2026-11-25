package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

type assistPreviewResponse struct {
	PairTicket   string   `json:"pair_ticket"`
	Operator     string   `json:"operator_label"`
	ServiceName  string   `json:"service_name"`
	SessionID    string   `json:"assist_session_id"`
	ExpiresAt    int64    `json:"expires_at"`
	Capabilities []string `json:"allowed_capabilities"`
	AccessMode   string   `json:"access_mode"`
}

var cliInputMu sync.Mutex

func readTerminalLine(reader *bufio.Reader, prompt string) (string, error) {
	cliInputMu.Lock()
	defer cliInputMu.Unlock()
	fmt.Print(prompt)
	line, err := reader.ReadString('\n')
	if err != nil && len(line) == 0 {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

var pairingCodeExtractPattern = regexp.MustCompile(`(?i)([A-F0-9]{5}-?[A-F0-9]{5})`)

// normalizePairingCode 从用户输入（纯协助码或粘贴的 "chloe XXXXX-XXXXX" 命令）中提取标准协助码。
func normalizePairingCode(raw string) string {
	trimmed := strings.ToUpper(strings.TrimSpace(raw))
	if trimmed == "" {
		return ""
	}
	if match := pairingCodeExtractPattern.FindStringSubmatch(trimmed); len(match) >= 2 {
		cleaned := strings.ReplaceAll(match[1], "-", "")
		if len(cleaned) == 10 {
			return cleaned[:5] + "-" + cleaned[5:]
		}
		return match[1]
	}
	return trimmed
}

func runAssistCLI(options assistOptions) error {
	if options.Server == "" {
		options.Server = "https://13-208-127-58.sslip.io/vault-api"
	}
	client, err := newAssistClient(options)
	if err != nil {
		return err
	}

	reader := bufio.NewReader(os.Stdin)
	code := strings.TrimSpace(options.Code)
	if code == "" {
		code, err = readTerminalLine(reader, "请输入 Witt 协助码: ")
		if err != nil {
			return errors.New("未读取到协助码")
		}
	}
	code = normalizePairingCode(code)
	if code == "" {
		return errors.New("协助码不能为空")
	}

	root := strings.TrimSpace(options.Root)
	if root == "" {
		if wd, wdErr := os.Getwd(); wdErr == nil && wd != "" {
			root = wd
		} else if home, hErr := os.UserHomeDir(); hErr == nil {
			root = home
		}
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("工作目录无效 (%s): %w", root, err)
	}
	info, err := os.Stat(canonicalRoot)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("工作目录不是有效文件夹: %s", canonicalRoot)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	previewReqCtx, cancelPreview := context.WithTimeout(ctx, 15*time.Second)
	var preview assistPreviewResponse
	err = client.request(previewReqCtx, "/assist/preview", "", map[string]any{"code": code}, &preview)
	cancelPreview()
	if err != nil {
		return err
	}

	modeLabel := "单目录安全模式 (读写/命令需本机确认)"
	if preview.AccessMode == "full" {
		modeLabel = "完整执行模式 (当前 Windows 用户权限，免逐条审批)"
	}

	fmt.Println()
	fmt.Println("========================================")
	fmt.Println("  Witt Remote Assist · 终端执行器")
	fmt.Println("----------------------------------------")
	fmt.Printf("  服务器:   %s\n", options.Server)
	fmt.Printf("  操作员:   %s\n", preview.Operator)
	fmt.Printf("  授权模式: %s\n", modeLabel)
	fmt.Printf("  默认目录: %s\n", canonicalRoot)
	if preview.ExpiresAt > 0 {
		expiresTime := time.UnixMilli(preview.ExpiresAt).Local()
		fmt.Printf("  有效期至: %s\n", expiresTime.Format("2006-01-02 15:04:05"))
	}
	fmt.Println("========================================")

	if !options.AutoApprove {
		answer, err := readTerminalLine(reader, "确认连接并授权? [Y/n]: ")
		if err != nil {
			return errors.New("已取消连接")
		}
		if answer != "" && !strings.EqualFold(answer, "y") && !strings.EqualFold(answer, "yes") {
			return errors.New("已取消连接")
		}
	}

	authPayload := map[string]any{
		"pair_ticket":          preview.PairTicket,
		"workspace_root":       canonicalRoot,
		"allowed_capabilities": preview.Capabilities,
	}
	if preview.AccessMode == "full" {
		authPayload["access_mode"] = "full"
		authPayload["consent_version"] = 2
	}

	authCtx, cancelAuth := context.WithTimeout(ctx, 15*time.Second)
	var grant assistGrant
	err = client.request(authCtx, "/assist/authorize", "", authPayload, &grant)
	cancelAuth()
	if err != nil {
		return err
	}

	processes := newProcessManager()
	defer processes.CloseAll()

	cliRecord := func(msg string) {
		fmt.Printf("[%s] %s\n", time.Now().Format("15:04:05"), msg)
	}
	cliApprove := func(approveCtx context.Context, title, detail string) bool {
		if options.AutoApprove {
			return true
		}
		type resp struct {
			ok bool
		}
		ch := make(chan resp, 1)
		go func() {
			cliInputMu.Lock()
			defer cliInputMu.Unlock()
			fmt.Println()
			fmt.Printf("--- 本机操作确认: %s ---\n%s\n", title, detail)
			fmt.Print("允许执行? [y/N]: ")
			line, _ := reader.ReadString('\n')
			ans := strings.TrimSpace(line)
			ch <- resp{ok: strings.EqualFold(ans, "y") || strings.EqualFold(ans, "yes")}
		}()
		select {
		case <-approveCtx.Done():
			return false
		case r := <-ch:
			return r.ok
		}
	}

	var assistExpires time.Time
	if grant.Expires > 0 {
		assistExpires = time.UnixMilli(grant.Expires)
	}
	isFull := grant.AccessMode == "full"
	config := agentConfig{
		roots:      map[string]string{"project": canonicalRoot},
		fullAccess: isFull,
		dialer:     client.dialer,
		processes:  processes,
		assist: &assistPolicy{
			sessionID:    grant.SessionID,
			expires:      assistExpires,
			capabilities: append([]string(nil), grant.Capabilities...),
			fullAccess:   isFull,
			approve:      cliApprove,
			record:       cliRecord,
		},
	}

	fmt.Println()
	cliRecord("授权成功，正在建立 WSS 长连接... (按 Ctrl+C 随时结束协助并断开)")

	// 退出时通知服务端撤销会话
	revokeOnExit := func() {
		processes.CloseAll()
		revCtx, cancelRev := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancelRev()
		var ignored map[string]any
		_ = client.request(revCtx, "/assist/state", grant.Token, map[string]any{"state": "revoked"}, &ignored)
	}

	backoff := time.Second
	for ctx.Err() == nil {
		if !config.assist.expires.IsZero() && !time.Now().Before(config.assist.expires) {
			cliRecord("协助授权已到期，正在退出")
			break
		}
		err := client.connect(ctx, grant, config)
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			if websocket.IsCloseError(err, 4003, 4001) {
				cliRecord("服务端已结束或替换本次协助会话")
				return nil
			}
			if strings.Contains(err.Error(), fmt.Sprintf("gateway HTTP %d", http.StatusUnauthorized)) ||
				strings.Contains(err.Error(), fmt.Sprintf("gateway HTTP %d", http.StatusForbidden)) {
				cliRecord("授权已失效或被撤销，停止重连")
				return nil
			}
			cliRecord(fmt.Sprintf("连接中断 (%v)，%s 后尝试重连...", err, backoff))
		} else {
			cliRecord(fmt.Sprintf("连接关闭，%s 后尝试重连...", backoff))
		}

		select {
		case <-ctx.Done():
		case <-time.After(backoff):
		}
		if backoff < 8*time.Second {
			backoff *= 2
			if backoff > 8*time.Second {
				backoff = 8 * time.Second
			}
		}
	}

	cliRecord("正在撤销本次协助并清理后台进程...")
	revokeOnExit()
	cliRecord("已安全退出")
	return nil
}
