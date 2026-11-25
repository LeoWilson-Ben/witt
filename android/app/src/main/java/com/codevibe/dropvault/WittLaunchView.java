package com.codevibe.dropvault;

import android.animation.ValueAnimator;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.BlurMaskFilter;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.SystemClock;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** Silk Ribbon optical launch surface; initialization happens behind the wordmark. */
public final class WittLaunchView extends View {
    private static final int RIBBON_COUNT = 7;
    private static final long MIN_DISPLAY_MS = 2100L;

    private final Paint ribbonPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint glowPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint wordPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint sheenPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint metaPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint dotPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path ribbonPath = new Path();

    private final boolean dark;
    private final long startedAt = SystemClock.uptimeMillis();
    private final boolean motion = ValueAnimator.areAnimatorsEnabled();
    private final ValueAnimator animator;
    private float elapsedSec;
    private boolean dismissing;
    private Runnable pendingDismiss;

    public WittLaunchView(Context context) {
        super(context);
        int nightMode = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        this.dark = (nightMode == Configuration.UI_MODE_NIGHT_YES);

        setBackgroundColor(dark ? Color.rgb(5, 8, 9) : Color.rgb(246, 247, 245));
        setContentDescription("Witt 正在启动");
        // Software layer ensures BlurMaskFilter works consistently across Android versions.
        setLayerType(LAYER_TYPE_SOFTWARE, null);

        ribbonPaint.setStyle(Paint.Style.STROKE);
        ribbonPaint.setStrokeCap(Paint.Cap.ROUND);
        ribbonPaint.setStrokeJoin(Paint.Join.ROUND);

        Typeface wordFace = Typeface.create("sans-serif-medium", Typeface.NORMAL);
        wordPaint.setTypeface(wordFace);
        wordPaint.setTextAlign(Paint.Align.CENTER);

        sheenPaint.setTypeface(wordFace);
        sheenPaint.setTextAlign(Paint.Align.CENTER);

        metaPaint.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        metaPaint.setTextAlign(Paint.Align.LEFT);

        dotPaint.setStyle(Paint.Style.FILL);

        animator = ValueAnimator.ofFloat(0f, 100f);
        animator.setDuration(100_000L);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(v -> {
            elapsedSec = (SystemClock.uptimeMillis() - startedAt) / 1000f;
            invalidate();
        });
        if (motion) {
            animator.start();
        } else {
            elapsedSec = 2.2f;
        }
    }

    private static float clamp(float value) {
        return Math.max(0f, Math.min(1f, value));
    }

    private static float easeOutQuint(float t) {
        float inv = 1f - clamp(t);
        return 1f - inv * inv * inv * inv * inv;
    }

    private static float easeOutCubic(float t) {
        float inv = 1f - clamp(t);
        return 1f - inv * inv * inv;
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float width = getWidth();
        float height = getHeight();
        if (width <= 0f || height <= 0f) return;

        float density = getResources().getDisplayMetrics().density;
        float minDim = Math.min(width, height);
        float cx = width * 0.5f;
        float cy = height * 0.5f;
        float t = elapsedSec;

        if (motion) {
            drawSilkRibbons(canvas, width, height, cx, cy, density, minDim, t);
        }

        // Phase 2: Leica blur-to-focus wordmark ("Witt")
        float focusT = motion ? easeOutQuint((t - 0.26f) / 0.96f) : 1f;
        float wordAlpha = motion ? clamp((t - 0.24f) / 0.65f) : 1f;
        float wordSize = Math.max(44f * density, Math.min(82f * density, minDim * 0.135f));
        float scale = 1.08f - 0.08f * focusT;
        float letterSpacing = 0.28f - 0.16f * focusT;
        float blurRadius = motion ? Math.max(0f, (1f - focusT) * 14f * density) : 0f;

        wordPaint.setTextSize(wordSize);
        wordPaint.setLetterSpacing(letterSpacing);
        int inkColor = dark ? Color.rgb(240, 247, 245) : Color.rgb(17, 33, 34);
        wordPaint.setColor(inkColor);
        wordPaint.setAlpha(Math.round(255f * wordAlpha));
        wordPaint.setMaskFilter(blurRadius > 0.6f
            ? new BlurMaskFilter(blurRadius, BlurMaskFilter.Blur.NORMAL)
            : null);

        Paint.FontMetrics fm = wordPaint.getFontMetrics();
        float wordBaseline = cy - (fm.ascent + fm.descent) * 0.5f - 8f * density;

        int saved = canvas.save();
        canvas.scale(scale, scale, cx, cy - 8f * density);
        if (wordAlpha > 0.005f) {
            canvas.drawText("Witt", cx, wordBaseline, wordPaint);

            // Phase 3: Diagonal optical glass sheen sweep across "Witt"
            float sheenT = motion ? clamp((t - 0.76f) / 1.05f) : 0f;
            if (motion && sheenT > 0f && sheenT < 1f) {
                float wordWidth = Math.max(wordPaint.measureText("Witt"), wordSize * 2.2f);
                float sweepStart = cx - wordWidth * 0.95f;
                float sweepEnd = cx + wordWidth * 0.95f;
                float sheenX = sweepStart + (sweepEnd - sweepStart) * easeOutCubic(sheenT);
                float bandHalf = wordWidth * 0.34f;
                float sheenOpacity = (float) Math.sin(sheenT * Math.PI);

                int accent = dark ? Color.rgb(98, 239, 214) : Color.rgb(20, 116, 104);
                int blue = dark ? Color.rgb(111, 182, 255) : Color.rgb(47, 115, 217);
                sheenPaint.setTextSize(wordSize);
                sheenPaint.setLetterSpacing(letterSpacing);
                sheenPaint.setShader(new LinearGradient(
                    sheenX - bandHalf, wordBaseline - wordSize * 0.6f,
                    sheenX + bandHalf, wordBaseline + wordSize * 0.25f,
                    new int[]{Color.TRANSPARENT, accent, Color.WHITE, blue, Color.TRANSPARENT},
                    new float[]{0f, 0.36f, 0.5f, 0.64f, 1f},
                    Shader.TileMode.CLAMP));
                sheenPaint.setAlpha(Math.round(235f * sheenOpacity));
                canvas.drawText("Witt", cx, wordBaseline, sheenPaint);
                sheenPaint.setShader(null);
            }
        }
        canvas.restoreToCount(saved);
        wordPaint.setMaskFilter(null);

        // Phase 4: Subtle status subtitle + live emerald pulse dot
        float metaT = motion ? easeOutCubic((t - 0.48f) / 0.68f) : 1f;
        if (metaT > 0.01f) {
            String label = "PRIVATE WORKSPACE · ONLINE";
            float metaSize = Math.max(9.5f * density, Math.min(11.5f * density, minDim * 0.025f));
            metaPaint.setTextSize(metaSize);
            metaPaint.setLetterSpacing(0.24f);
            int muted = dark ? Color.argb(Math.round(136f * metaT), 214, 234, 230)
                             : Color.argb(Math.round(132f * metaT), 17, 33, 34);
            metaPaint.setColor(muted);

            float textWidth = metaPaint.measureText(label);
            float dotRadius = 2.8f * density;
            float gap = 8f * density;
            float totalW = dotRadius * 2f + gap + textWidth;
            float startX = cx - totalW * 0.5f;
            float metaY = wordBaseline + 28f * density + (1f - metaT) * 9f * density;

            float dotPulse = motion ? (0.72f + 0.28f * (float) Math.sin(t * 3.1f)) : 1f;
            int dotColor = dark ? Color.rgb(98, 239, 214) : Color.rgb(20, 116, 104);
            dotPaint.setColor(dotColor);
            dotPaint.setAlpha(Math.round(255f * metaT * dotPulse));
            dotPaint.setShadowLayer(6f * density, 0f, 0f, dotColor);
            float dotCy = metaY - metaSize * 0.34f;
            canvas.drawCircle(startX + dotRadius, dotCy, dotRadius, dotPaint);
            dotPaint.clearShadowLayer();

            canvas.drawText(label, startX + dotRadius * 2f + gap, metaY, metaPaint);
        }
    }

    private void drawSilkRibbons(Canvas canvas, float width, float height, float cx, float cy,
                                 float density, float minDim, float t) {
        float fadeIn = clamp(t / 0.32f);
        float energy = 0.22f + 0.78f * (float) Math.exp(-t * 1.5f);
        float heightScale = height < 500f * density ? 0.65f : 1f;

        // Soft central caustic glow
        float glowR = minDim * 0.42f;
        int glowCenter = dark
            ? Color.argb(Math.round(38f * fadeIn), 98, 239, 214)
            : Color.argb(Math.round(24f * fadeIn), 20, 116, 104);
        int glowMid = dark
            ? Color.argb(Math.round(14f * fadeIn), 111, 182, 255)
            : Color.argb(Math.round(10f * fadeIn), 47, 115, 217);
        glowPaint.setShader(new RadialGradient(cx, cy, glowR,
            new int[]{glowCenter, glowMid, Color.TRANSPARENT},
            new float[]{0f, 0.52f, 1f}, Shader.TileMode.CLAMP));
        canvas.drawRect(0f, 0f, width, height, glowPaint);
        glowPaint.setShader(null);

        // 7 interlaced harmonic silk ribbons
        int steps = Math.max(40, Math.min(72, (int) (width / (14f * density))));
        for (int r = 0; r < RIBBON_COUNT; r++) {
            float ratio = r / (float) (RIBBON_COUNT - 1);
            float centerWeight = 1f - Math.abs(ratio - 0.5f) * 2f;
            float phase = t * (1.28f + r * 0.14f) + r * 0.75f;
            float amp = (16f + r * 9.5f) * density * energy * heightScale;
            float freq = (0.0042f + r * 0.0007f) / density;

            ribbonPath.reset();
            for (int i = 0; i <= steps; i++) {
                float u = i / (float) steps;
                float x = u * width;
                float env = (float) Math.sin(u * Math.PI);
                float env2 = env * env;
                float y = cy
                    + (float) Math.sin(x * freq + phase) * amp * env2
                    + (float) Math.cos(x * freq * 1.9f - phase * 0.8f) * (amp * 0.42f) * env2;
                if (i == 0) ribbonPath.moveTo(x, y);
                else ribbonPath.lineTo(x, y);
            }

            float alphaBase = dark
                ? (0.15f + centerWeight * 0.25f) * fadeIn
                : (0.10f + centerWeight * 0.16f) * fadeIn;
            int aSide = Math.round(255f * alphaBase);
            int aMid = Math.round(255f * Math.min(1f, alphaBase * 1.25f));
            int[] colors = dark
                ? new int[]{
                    Color.TRANSPARENT,
                    Color.argb(aSide, 98, 239, 214),
                    Color.argb(aMid, 185, 255, 245),
                    Color.argb(aSide, 111, 182, 255),
                    Color.TRANSPARENT}
                : new int[]{
                    Color.TRANSPARENT,
                    Color.argb(aSide, 20, 116, 104),
                    Color.argb(aMid, 38, 152, 138),
                    Color.argb(aSide, 47, 115, 217),
                    Color.TRANSPARENT};

            ribbonPaint.setShader(new LinearGradient(0f, cy, width, cy,
                colors, new float[]{0f, 0.28f, 0.5f, 0.72f, 1f}, Shader.TileMode.CLAMP));
            ribbonPaint.setStrokeWidth((1.15f + centerWeight * 1.25f) * density);
            canvas.drawPath(ribbonPath, ribbonPaint);
        }
        ribbonPaint.setShader(null);
    }

    public void dismiss(Runnable complete) {
        if (dismissing) return;
        dismissing = true;
        long wait = motion ? Math.max(0L, MIN_DISPLAY_MS - (SystemClock.uptimeMillis() - startedAt)) : 0L;
        pendingDismiss = () -> {
            animator.cancel();
            animate().alpha(0f).scaleX(1.04f).scaleY(1.04f)
                .setDuration(motion ? 420L : 0L)
                .withEndAction(complete)
                .start();
        };
        postDelayed(pendingDismiss, wait);
    }

    @Override
    protected void onDetachedFromWindow() {
        if (pendingDismiss != null) removeCallbacks(pendingDismiss);
        animator.cancel();
        animate().cancel();
        super.onDetachedFromWindow();
    }
}
