package com.codevibe.dropvault;
import android.app.*;
import android.content.*;
import android.os.*;
import java.util.concurrent.*;

public final class TaskNotificationService extends Service {
    private ScheduledExecutorService executor;
    private int failures;
    public static void start(Context context){try{context.startForegroundService(new Intent(context,TaskNotificationService.class));}catch(RuntimeException ignored){}}
    @Override public void onCreate(){super.onCreate();
        NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(new NotificationChannel("witt_task_monitor","任务状态监测",NotificationManager.IMPORTANCE_LOW));
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        startForeground(TaskNotificationMonitor.FOREGROUND,new Notification.Builder(this,"witt_task_monitor").setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("Witt 任务进行中").setContentText("任务完成或等待确认时提醒你").setContentIntent(open).setOngoing(true).build());
        executor=Executors.newSingleThreadScheduledExecutor();executor.scheduleWithFixedDelay(()->{
            try{boolean active=TaskNotificationMonitor.poll(this);failures=0;if(!active)stopSelf();}catch(Exception ignored){if(++failures>=20)stopSelf();}
        },0,15,TimeUnit.SECONDS);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){return START_NOT_STICKY;}
    @Override public android.os.IBinder onBind(Intent intent){return null;}
    @Override public void onDestroy(){if(executor!=null)executor.shutdownNow();super.onDestroy();}
    @Override public void onTimeout(int startId,int fgsType){stopSelf();}
}
