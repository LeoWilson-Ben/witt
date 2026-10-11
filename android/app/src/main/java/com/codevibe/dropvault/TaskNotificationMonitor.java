package com.codevibe.dropvault;

import android.Manifest;
import android.app.*;
import android.app.job.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;
import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import java.util.concurrent.*;

/** Uses the existing Keystore envelope; credentials never pass through JavaScript. */
public final class TaskNotificationMonitor {
    static final String PREFS="witt-task-notifications", CHANNEL="witt_tasks";
    static final int JOB=8243, FOREGROUND=8244;
    private TaskNotificationMonitor() {}
    static SharedPreferences prefs(Context context){return context.getSharedPreferences(PREFS,Context.MODE_PRIVATE);}
    public static boolean enabled(Context context){return prefs(context).getBoolean("enabled",false);}
    public static void configure(Context context, boolean enabled, String apiUrl){
        prefs(context).edit().putBoolean("enabled",enabled).putString("api",apiUrl).apply();
        JobScheduler scheduler=(JobScheduler)context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if(enabled){
            NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
            manager.createNotificationChannel(new NotificationChannel(CHANNEL,"任务完成与确认",NotificationManager.IMPORTANCE_DEFAULT));
            scheduler.schedule(new JobInfo.Builder(JOB,new ComponentName(context,TaskNotificationJob.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(15*60*1000L).setPersisted(true).build());
            TaskNotificationService.start(context);
        }else{scheduler.cancel(JOB);context.stopService(new Intent(context,TaskNotificationService.class));}
    }
    public static void snapshot(Context context,String json,String apiUrl){
        if(!enabled(context))return;
        prefs(context).edit().putString("api",apiUrl).apply();
        try{JSONArray values=new JSONArray(json);for(int i=0;i<values.length();i++)if(values.getJSONObject(i).optBoolean("busy")){TaskNotificationService.start(context);return;}}catch(Exception ignored){}
    }
    static String token(Context context)throws Exception{
        SharedPreferences auth=context.getSharedPreferences("witt-device-auth",Context.MODE_PRIVATE);
        String envelope=auth.getString("device_token_v2","");if(envelope==null||envelope.isEmpty())return "";
        String[] parts=envelope.split("\\.",2);if(parts.length!=2)return "";
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias("witt-device-auth-v2"))return "";
        SecretKey key=((KeyStore.SecretKeyEntry)store.getEntry("witt-device-auth-v2",null)).getSecretKey();
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
    }
    static JSONObject get(Context context,String endpoint)throws Exception{
        String base=prefs(context).getString("api",BuildConfig.API_URL);
        // A background job can only use the app's two compiled API origins.
        if(!BuildConfig.API_URL.equals(base)&&!BuildConfig.FALLBACK_API_URL.equals(base))throw new IOException("Origin unavailable");
        String credential=token(context);if(credential.isEmpty())throw new IOException("Authentication unavailable");
        HttpURLConnection connection=(HttpURLConnection)new URL(base+endpoint).openConnection();
        try{connection.setConnectTimeout(10000);connection.setReadTimeout(15000);connection.setRequestProperty("Authorization","Bearer "+credential);
            if(connection.getResponseCode()!=200)throw new IOException("Task monitor unavailable");
            ByteArrayOutputStream body=new ByteArrayOutputStream();byte[] buffer=new byte[8192];try(InputStream input=connection.getInputStream()){int n;while((n=input.read(buffer))!=-1){if(body.size()+n>2*1024*1024)throw new IOException("Response too large");body.write(buffer,0,n);}}
            return new JSONObject(body.toString("UTF-8"));
        }finally{connection.disconnect();}
    }
    static boolean poll(Context context)throws Exception{
        if(!enabled(context))return false;
        SharedPreferences prefs=prefs(context);String base=prefs.getString("api",BuildConfig.API_URL);String key="cursor-"+Integer.toHexString(base.hashCode());
        long after=prefs.getLong(key,-1);JSONObject events=get(context,"chat/notifications?after="+Math.max(0,after));
        if(after>=0){JSONArray values=events.optJSONArray("events");if(values!=null)for(int i=0;i<values.length();i++)show(context,values.getJSONObject(i));}
        prefs.edit().putLong(key,events.optLong("latestSequence",Math.max(0,after))).apply();
        JSONArray conversations=get(context,"chat/conversations").optJSONArray("conversations");
        if(conversations!=null)for(int i=0;i<conversations.length();i++)if(conversations.getJSONObject(i).optBoolean("busy"))return true;
        return false;
    }
    static void show(Context context,JSONObject event){
        if(Build.VERSION.SDK_INT>=33&&context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)return;
        String state=event.optString("state"),label;
        if("completed".equals(state))label="任务已完成";else if("failed".equals(state))label="任务执行失败";else if("awaiting_confirmation".equals(state))label="任务等待你确认";else return;
        String id=event.optString("conversationId");if(!id.matches("[a-f0-9-]{36}"))return;
        Intent intent=new Intent(context,MainActivity.class).putExtra("open_conversation",id).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content=PendingIntent.getActivity(context,id.hashCode(),intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification notification=new Notification.Builder(context,CHANNEL).setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(label).setContentText(event.optString("title","Witt 任务")).setContentIntent(content).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).build();
        ((NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE)).notify(id.hashCode(),notification);
    }
}
