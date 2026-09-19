# 重新编译 OverlayHost.dex

## 依赖

- JDK（javac）
- `android.jar`（本项目使用精简版，仅需编译期符号）
- `r8.jar`（含 D8）

设备内现成环境（已就绪）：

```
/tmp/m1/android.jar      12.9MB
/tmp/m1/r8.jar           20.6MB（r8 9.4.17）
/usr/bin/javac           openjdk 17
```

## 步骤

```bash
cd /tmp/m1
rm -rf src/com/deskpet out/com dexout
mkdir -p src/com/deskpet out
cp /sdcard/Download/Operit/dev_package/deskpet/native-src/OverlayHost.java src/com/deskpet/

# 1) 编译（source/target 8）
javac -source 8 -target 8 -cp android.jar -d out src/com/deskpet/OverlayHost.java

# 2) 转 dex
java -cp r8.jar com.android.tools.r8.D8 --min-api 26 --lib android.jar \
     --output dexout out/com/deskpet/*.class

# 3) 部署
cp dexout/classes.dex /sdcard/Download/Operit/dev_package/deskpet/resources/native/overlay.dex
```

改完 dex 后需要用 `debug_install_toolpkg` 重新烧录整个包。

## 已编译包名

- 类：`com.deskpet.OverlayHost`
- 加载时 `childFirstPrefixes: ['com.deskpet.']`

## 约束

- **只依赖 `android.jar`**，不引入第三方库（`android.jar` 无 `org.json`，故原生侧
  不使用 JSON 库：输入走强类型参数，输出手工拼 JSON）。
- `android.jar` 为 API16，API16 之后的接口（如 `Settings.canDrawOverlays`，API23）
  需用反射调用，否则编译期找不到符号。

## JS 侧依赖的静态方法签名（改动必须同步 main.js）

```java
void   show(Context, String petHtml, String bubbleHtml, int sizeDp, int maxWidthDp, int x, int y, boolean snap)
void   hide(Context)
void   hideForReload(Context)
void   restore(Context, String petHtml, String bubbleHtml, int sizeDp, int maxWidthDp, int x, int y, boolean snap)
void   applyConfig(Context, int sizeDp, int maxWidthDp, boolean snap, int x, int y)
void   setPetHtml(Context, String html)
void   setBubbleHtml(Context, String html)
String getState(Context)
void   petEval(Context, String js)
void   showBubble(Context, String linesJson, int durationMs, int maxWidthDp)
void   hideBubble(Context)
String consumeEvent(Context)
void   acknowledgePoke(Context, boolean)
void   vibrate(Context, int ms)
```