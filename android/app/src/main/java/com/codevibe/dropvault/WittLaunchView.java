package com.codevibe.dropvault;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;

/**
 * Native copy of Witt's connection screen shown while the WebView is loading.
 * It communicates activity without pretending to know network progress.
 */
public final class WittLaunchView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final ValueAnimator animator;
    private float phase;

    public WittLaunchView(Context context) {
        super(context);
        setBackgroundColor(Color.rgb(247, 249, 254));
        setContentDescription("Witt 正在连接你的服务器");
        setLayerType(LAYER_TYPE_SOFTWARE, null);
        textPaint.setTextAlign(Paint.Align.CENTER);
        animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(3200L);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setRepeatMode(ValueAnimator.REVERSE);
        animator.setInterpolator(new AccelerateDecelerateInterpolator());
        animator.addUpdateListener(value -> {
            phase = (float) value.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float width = getWidth();
        float height = getHeight();
        float cx = width * .5f;
        float cy = height * (width > height ? .42f : .44f);

        paint.setStyle(Paint.Style.FILL);
        paint.setShader(new RadialGradient(
            cx, cy, Math.min(width, height) * .55f,
            new int[]{Color.rgb(239, 244, 255), Color.rgb(247, 249, 254)},
            new float[]{0f, 1f}, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, height, paint);
        paint.setShader(null);

        textPaint.setTextAlign(Paint.Align.LEFT);
        textPaint.setTypeface(Typeface.create("sans-serif-black", Typeface.NORMAL));
        textPaint.setTextSize(dp(52));
        textPaint.setLetterSpacing(-.045f);
        String word = "Witt";
        float wordWidth = textPaint.measureText(word);
        textPaint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        float dotWidth = textPaint.measureText(".");
        float wordStart = cx - (wordWidth + dotWidth) * .5f;
        textPaint.setTypeface(Typeface.create("sans-serif-black", Typeface.NORMAL));
        textPaint.setColor(Color.rgb(23, 36, 58));
        canvas.drawText(word, wordStart, cy, textPaint);
        textPaint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        textPaint.setColor(Color.rgb(43, 120, 220));
        canvas.drawText(".", wordStart + wordWidth, cy, textPaint);

        float titleY = cy + dp(43);
        textPaint.setTextAlign(Paint.Align.CENTER);
        textPaint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        textPaint.setTextSize(dp(8));
        textPaint.setLetterSpacing(.24f);
        textPaint.setColor(Color.rgb(128, 144, 168));
        canvas.drawText("PRIVATE SERVER CODEX", cx, titleY, textPaint);

        float trackWidth = dp(112);
        float trackHeight = dp(2);
        float trackLeft = cx - trackWidth * .5f;
        float trackTop = titleY + dp(34);
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(Color.rgb(223, 229, 238));
        canvas.drawRoundRect(
            trackLeft, trackTop, trackLeft + trackWidth, trackTop + trackHeight,
            trackHeight, trackHeight, paint);
        float segmentWidth = trackWidth * .45f;
        float segmentLeft = trackLeft + (trackWidth - segmentWidth) * phase;
        paint.setColor(Color.rgb(45, 167, 180));
        canvas.drawRoundRect(
            segmentLeft, trackTop, segmentLeft + segmentWidth, trackTop + trackHeight,
            trackHeight, trackHeight, paint);

        textPaint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        textPaint.setTextSize(dp(9));
        textPaint.setLetterSpacing(.04f);
        textPaint.setColor(Color.rgb(139, 152, 170));
        canvas.drawText("正在连接你的服务器", cx, trackTop + dp(24), textPaint);
    }

    public void dismiss(Runnable complete) {
        animator.cancel();
        animate()
            .alpha(0f)
            .scaleX(1.015f)
            .scaleY(1.015f)
            .setDuration(380L)
            .withEndAction(complete)
            .start();
    }

    @Override
    protected void onDetachedFromWindow() {
        animator.cancel();
        super.onDetachedFromWindow();
    }
}
