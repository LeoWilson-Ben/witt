package com.codevibe.dropvault;
import android.app.job.*;
import java.util.concurrent.*;
public final class TaskNotificationJob extends JobService {
    private ExecutorService executor;
    @Override public boolean onStartJob(JobParameters parameters){executor=Executors.newSingleThreadExecutor();executor.execute(()->{try{TaskNotificationMonitor.poll(this);}catch(Exception ignored){}finally{jobFinished(parameters,false);executor.shutdown();}});return true;}
    @Override public boolean onStopJob(JobParameters parameters){if(executor!=null)executor.shutdownNow();return true;}
}
