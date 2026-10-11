package com.codevibe.dropvault;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PathMeasure;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.os.SystemClock;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** The sole Android launch surface; initialization happens behind the wordmark. */
public final class WittLaunchView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path[] letters = {new Path(), new Path(), new Path(), new Path()};
    private final Path visible = new Path();
    private final float[] starts = {160, 870, 1130, 1430};
    private final float[] durations = {900, 380, 440, 440};
    private final long startedAt = SystemClock.uptimeMillis();
    private final boolean motion = ValueAnimator.areAnimatorsEnabled();
    private final ValueAnimator animator;
    private float time;
    private boolean dismissing;
    private Runnable pendingDismiss;

    public WittLaunchView(Context context) {
        super(context);
        setBackgroundColor(Color.rgb(249,250,248));
        setContentDescription("Witt 正在启动");
        setLayerType(LAYER_TYPE_SOFTWARE, null);
        Path w=letters[0];
        w.moveTo(24,30);w.lineTo(49,112);w.quadTo(52,124,57,112);
        w.lineTo(80,54);w.lineTo(103,112);w.quadTo(108,124,111,112);w.lineTo(136,30);
        Path i=letters[1];
        i.moveTo(158,40);i.lineTo(158,40.2f);i.moveTo(158,66);i.lineTo(158,109);i.quadTo(158,124,169,114);
        for(int n=2;n<4;n++){
            float x=n==2?198:244;
            letters[n].moveTo(x,36);letters[n].lineTo(x,107);letters[n].quadTo(x,127,x+15,114);
            letters[n].moveTo(x-14,67);letters[n].lineTo(x+14,67);
        }
        animator=ValueAnimator.ofFloat(0,2700);
        animator.setDuration(2700);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(value->{time=(float)value.getAnimatedValue();invalidate();});
        if(motion)animator.start();else time=2700;
    }

    private float clamp(float value){return Math.max(0,Math.min(1,value));}
    private float ease(float value){float p=clamp(value);return p*p*(3-2*p);}

    @Override protected void onDraw(Canvas canvas){
        super.onDraw(canvas);
        float density=getResources().getDisplayMetrics().density;
        float width=getWidth(),height=getHeight(),cx=width*.5f,cy=height*.5f;
        float size=Math.min(300*density,Math.min(width*.76f,height*.95f));
        if(size<=0)return;
        float entrance=ease(time/850),scale=.96f+.04f*entrance;
        if(motion){
            paint.setStyle(Paint.Style.FILL);
            paint.setShader(new RadialGradient(cx,cy,size*.8f,
                new int[]{Color.argb(Math.round(36*(float)Math.sin(clamp(time/3200)*(float)Math.PI)),129,178,157),Color.TRANSPARENT},
                null,Shader.TileMode.CLAMP));
            canvas.drawRect(0,0,width,height,paint);paint.setShader(null);
        }
        int checkpoint=canvas.save();
        canvas.translate(cx-size*.5f,cy-size*150/280*.5f);
        canvas.scale(size/280,size/280);
        canvas.scale(scale,scale,140,75);
        canvas.translate(0,5*(1-entrance));
        paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(8.5f);
        paint.setStrokeCap(Paint.Cap.ROUND);paint.setStrokeJoin(Paint.Join.ROUND);
        paint.setShader(new LinearGradient(0,0,238,150,
            new int[]{Color.rgb(37,59,55),Color.rgb(127,170,160),Color.rgb(37,59,55)},
            new float[]{0,.46f,1},Shader.TileMode.CLAMP));
        float[] nib=null;
        for(int n=0;n<letters.length;n++){
            float progress=ease((time-starts[n])/durations[n]);
            PathMeasure measure=new PathMeasure(letters[n],false);
            float total=0;do{total+=measure.getLength();}while(measure.nextContour());
            measure.setPath(letters[n],false);
            float remaining=total*progress;
            visible.reset();
            do{
                float length=measure.getLength(),drawn=Math.min(length,remaining);
                if(drawn>0)measure.getSegment(0,drawn,visible,true);
                if(progress>0 && progress<1 && remaining>0 && remaining<=length){
                    float[] position=new float[2];
                    if(measure.getPosTan(drawn,position,null))nib=position;
                }
                remaining-=length;
            }while(remaining>0 && measure.nextContour());
            canvas.drawPath(visible,paint);
        }
        paint.setShader(null);
        float shine=clamp((time-1900)/800);
        if(motion && shine>0 && shine<1){
            float x=-80+460*shine;
            paint.setShader(new LinearGradient(x-65,0,x+65,20,
                new int[]{Color.TRANSPARENT,Color.rgb(213,238,230),Color.TRANSPARENT},
                new float[]{0,.5f,1},Shader.TileMode.CLAMP));
            paint.setAlpha(Math.round(190*(float)Math.sin(shine*Math.PI)));
            for(Path letter:letters)canvas.drawPath(letter,paint);
            paint.setAlpha(255);paint.setShader(null);
        }
        if(motion && nib!=null){
            paint.setStyle(Paint.Style.FILL);paint.setColor(Color.rgb(213,238,230));
            paint.setShadowLayer(8,0,0,Color.rgb(127,170,160));
            canvas.drawCircle(nib[0],nib[1],2.4f,paint);paint.clearShadowLayer();
        }
        canvas.restoreToCount(checkpoint);
    }

    public void dismiss(Runnable complete){
        if(dismissing)return;dismissing=true;
        long wait=motion?Math.max(0,2800-(SystemClock.uptimeMillis()-startedAt)):0;
        pendingDismiss=()->{
            animator.cancel();
            animate().alpha(0).scaleX(1.035f).scaleY(1.035f)
                .setDuration(motion?380:0).withEndAction(complete).start();
        };
        postDelayed(pendingDismiss,wait);
    }

    @Override protected void onDetachedFromWindow(){
        if(pendingDismiss!=null)removeCallbacks(pendingDismiss);
        animator.cancel();animate().cancel();super.onDetachedFromWindow();
    }
}
