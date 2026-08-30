-keepclassmembers class com.codevibe.dropvault.MainActivity$WebBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# JSch selects negotiated algorithms by configured class name.
-keep class com.jcraft.jsch.** { *; }

# Optional desktop/provider integrations are not used by the Android terminal.
-dontwarn com.sun.jna.**
-dontwarn org.apache.logging.log4j.**
-dontwarn org.bouncycastle.**
-dontwarn org.ietf.jgss.**
-dontwarn org.newsclub.net.unix.**
-dontwarn org.slf4j.**
