# Capacitor 核心与插件注册依赖反射/注解，混淆时必须保留
-keepattributes *Annotation*
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod *;
}
-keep class com.forforever.app.** { *; }
-dontwarn com.getcapacitor.**