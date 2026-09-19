package com.deskpet;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.PixelFormat;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;

/**
 * 桌宠原生宿主（纯管道，零业务逻辑）。
 *
 * 只负责 JS 做不到的事：
 *   1. 在主线程创建 / 撤销 / 移动两个 overlay 窗口（宠物 + 气泡）
 *   2. 承载 WebView 并加载 HTML
 *   3. 窗口层触摸拦截（拖动 / 戳），不把触摸传给 WebView
 *   4. 位置持久化
 *   5. 备用 1s 心跳（JS 定时器被系统节流时的兜底）
 *
 * 所有形象 / 台词 / 调度 / 网络 / 配置读写都在 JS 侧。
 *
 * 线程模型：JS 引擎跑在 OperitQuickJsRuntime 线程（无 Looper），
 * 因此所有 UI 操作都 post 到主线程；供 JS 读回的字段一律 volatile。
 *
 * 依赖约束：只依赖 android.jar，不引入第三方库（故不使用 org.json）。
 * 输入用强类型参数，输出手工拼 JSON。
 */
public final class OverlayHost {

    private static final int TYPE_APP_OVERLAY = 2038; // WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    private static final int PET_FLAGS = 8 | 32 | 512;      // NOT_FOCUSABLE | NOT_TOUCH_MODAL | LAYOUT_NO_LIMITS
    private static final int BUBBLE_FLAGS = 8 | 16 | 512;   // NOT_FOCUSABLE | NOT_TOUCHABLE | LAYOUT_NO_LIMITS
    private static volatile float slopPx = 32f;              // 戳/拖判定阈值（px，运行时按屏幕密度计算）
    private static final String PREFS = "deskpet_overlay";
    private static final String DEFAULT_BASE = "https://deskpet.local/";

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static volatile WebView petView;
    private static volatile WebView bubbleView;
    private static volatile WindowManager wm;
    private static volatile WindowManager.LayoutParams petLp;
    private static volatile WindowManager.LayoutParams bubbleLp;

    private static volatile boolean visible;
    private static volatile boolean bubbleShown;
    private static volatile boolean dragging;
    private static volatile boolean snapToEdge;
    private static volatile int petSizePx = 240;
    private static volatile int bubbleWpx = 540;
    private static volatile int bubbleHpx = 540;
    private static volatile String lastError = "";

    // 触摸输入状态（主线程读写）
    private static float downX, downY;
    private static int startX, startY;

    // 供 JS 轮询取走的事件（跨线程 volatile）
    private static volatile boolean pendingPoke;
    private static volatile boolean bubbleBelow;
    private static volatile boolean pendingResized;
    private static volatile boolean pendingDragEnd;
    private static volatile int dragEndX, dragEndY;
    private static volatile long tick;

    // 长按手势（用于隐藏桌宠）：ACTION_DOWN 起计时，未拖动则判定为长按
    private static volatile boolean pendingLongPress; // 待 JS 取走的长按事件
    private static boolean longPressFired;             // 当前手势是否已判定为长按
    private static View touchView;                     // 当前手势的触摸视图（长按回调取 Context）
    private static final int LONG_PRESS_MS = 2000;      // 长按判定阈值（毫秒）

    private static Runnable heartbeat;

    // 用于跨 JS 引擎去重：给两个 WebView 打标记，新实例启动时清理旧实例遗留的窗口
    private static final String TAG_PET = "deskpet_pet";
    private static final String TAG_BUBBLE = "deskpet_bubble";

    /** 上一次 removeStaleOverlays 的诊断信息（调试用，写入 state 便于排查）。 */
    private static volatile String cleanupInfo = "none";

    private OverlayHost() {
    }

    // ==================== 生命周期 ====================

    /** 显示桌宠。x/y 传 -1 表示沿用已持久化位置。 */
    public static void show(final Context ctx, final String petHtml, final String bubbleHtml,
                            final int sizeDp, final int maxWidthDp,
                            final int x, final int y, final boolean snap) {
        MAIN.post(new Runnable() {
            public void run() {
                doShow(ctx, petHtml, bubbleHtml, sizeDp, maxWidthDp, x, y, snap);
            }
        });
    }

    public static void hide(final Context ctx) {
        MAIN.post(new Runnable() {
            public void run() {
                doHide();
            }
        });
    }

    public static void hideForReload(final Context ctx) {
        MAIN.post(new Runnable() {
            public void run() {
                doHide();
            }
        });
    }

    public static void restore(final Context ctx, final String petHtml, final String bubbleHtml,
                               final int sizeDp, final int maxWidthDp,
                               final int x, final int y, final boolean snap) {
        show(ctx, petHtml, bubbleHtml, sizeDp, maxWidthDp, x, y, snap);
    }

    /** 运行时改配置。x/y 传 -1 表示不改。 */
    public static void applyConfig(final Context ctx, final int sizeDp, final int maxWidthDp,
                                   final boolean snap, final int x, final int y) {
        MAIN.post(new Runnable() {
            public void run() {
                doApplyConfig(ctx, sizeDp, maxWidthDp, snap, x, y);
            }
        });
    }

    /** 重载宠物壳 HTML（换皮肤时用，不撤窗）。 */
    public static void setPetHtml(final Context ctx, final String html) {
        MAIN.post(new Runnable() {
            public void run() {
                try {
                    if (petView != null) {
                        petView.loadDataWithBaseURL(DEFAULT_BASE, html, "text/html", "utf-8", null);
                    }
                } catch (Throwable t) {
                    lastError = String.valueOf(t);
                }
            }
        });
    }

    /** 重载气泡壳 HTML。 */
    public static void setBubbleHtml(final Context ctx, final String html) {
        MAIN.post(new Runnable() {
            public void run() {
                try {
                    if (bubbleView != null) {
                        bubbleView.loadDataWithBaseURL(DEFAULT_BASE, html, "text/html", "utf-8", null);
                    }
                } catch (Throwable t) {
                    lastError = String.valueOf(t);
                }
            }
        });
    }

    // ==================== 状态 ====================

    public static String getState(Context ctx) {
        StringBuilder sb = new StringBuilder(160);
        sb.append('{');
        sb.append("\"visible\":").append(visible && petView != null);
        sb.append(",\"canOverlay\":").append(canOverlay(ctx));
        sb.append(",\"bubble\":").append(bubbleShown);
        sb.append(",\"below\":").append(bubbleBelow);
        sb.append(",\"dragging\":").append(dragging);
        sb.append(",\"tick\":").append(tick);
        WindowManager.LayoutParams lp = petLp;
        if (lp != null) {
            sb.append(",\"x\":").append(lp.x).append(",\"y\":").append(lp.y);
            sb.append(",\"w\":").append(petSizePx).append(",\"h\":").append(petSizePx);
        }
        if (lastError != null && lastError.length() > 0) {
            sb.append(",\"error\":").append(jstr(lastError));
        }
        sb.append(",\"cleanup\":").append(jstr(cleanupInfo));
        sb.append('}');
        return sb.toString();
    }

    // ==================== 渲染推送 ====================

    /** 向宠物壳注入 JS 片段，例如 PetBridge.setState('poke')。 */
    public static void petEval(final Context ctx, final String js) {
        MAIN.post(new Runnable() {
            public void run() {
                if (petView != null) {
                    evalJs(petView, js);
                }
            }
        });
    }

    /** 显示气泡。linesJson 是 [{t,s,c}] 的 JSON/JS 字面量。 */
    public static void showBubble(final Context ctx, final String linesJson,
                                  final int durationMs, final int maxWidthDp) {
        MAIN.post(new Runnable() {
            public void run() {
                doShowBubble(ctx, linesJson, durationMs, maxWidthDp);
            }
        });
    }

    public static void hideBubble(final Context ctx) {
        MAIN.post(new Runnable() {
            public void run() {
                doHideBubble();
            }
        });
    }

    // ==================== 事件轮询 ====================

    /** JS 每 tick 取走一次性事件。 */
    public static String consumeEvent(Context ctx) {
        StringBuilder sb = new StringBuilder(128);
        sb.append('{');
        boolean poke = pendingPoke;
        pendingPoke = false;
        sb.append("\"poke\":").append(poke);
        boolean lp = pendingLongPress;
        pendingLongPress = false;
        sb.append(",\"longPress\":").append(lp);
        if (pendingDragEnd) {
            pendingDragEnd = false;
            sb.append(",\"dragEnd\":{\"x\":").append(dragEndX).append(",\"y\":").append(dragEndY).append('}');
        } else {
            sb.append(",\"dragEnd\":null");
        }
        boolean rz = pendingResized;
        pendingResized = false;
        sb.append(",\"resized\":").append(rz);
        sb.append(",\"bubble\":").append(bubbleShown);
        sb.append(",\"below\":").append(bubbleBelow);
        sb.append(",\"dragging\":").append(dragging);
        sb.append(",\"tick\":").append(tick);
        WindowManager.LayoutParams blp = bubbleLp;
        if (blp != null) {
            sb.append(",\"bx\":").append(blp.x).append(",\"by\":").append(blp.y);
        }
        sb.append('}');
        return sb.toString();
    }

    public static void acknowledgePoke(Context ctx, boolean ok) {
    }

    public static void vibrate(final Context ctx, final int ms) {
        MAIN.post(new Runnable() {
            public void run() {
                doVibrate(ctx, ms);
            }
        });
    }

    // ==================== 主线程实现 ====================

    /**
     * 清理本进程内、由其它 JS 引擎（旧实例）遗留在 WindowManagerGlobal 里的桌宠窗口。
     * WindowManagerGlobal 是进程级单例，因此即使旧引擎的静态引用已失效，也能枚举并移除其 View。
     * 全程反射调用：android.jar 为 API16，WindowManagerGlobal 在 API17 才有。
     */
    private static void removeStaleOverlays(Context ctx) {
        try {
            Class<?> wmgCls = Class.forName("android.view.WindowManagerGlobal");
            Object wmg = wmgCls.getMethod("getInstance").invoke(null);
            java.lang.reflect.Field f = wmgCls.getDeclaredField("mRoots");
            f.setAccessible(true);
            Object rootsObj = f.get(wmg);
            if (!(rootsObj instanceof java.util.List)) {
                cleanupInfo = "mRoots not a List";
                return;
            }
            java.util.List<?> roots = (java.util.List<?>) rootsObj;
            WindowManager w = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            String rmErr = "";
            int totalVictims = 0, totalRemoved = 0, passes = 0;
            int cNotView = 0, cTagOther = 0, cEmptyNoweb = 0, cEmptyWebNotOverlay = 0, cGetViewFail = 0;
            StringBuilder detail = new StringBuilder(160);
            // 多轮扫描：移除视图会让 mRoots 变动（且旧引擎可能仍在写），单轮可能漏掉若干窗口。
            for (int pass = 0; pass < 4; pass++) {
                passes = pass + 1;
                int n = roots.size();
                java.util.List<View> victims = new java.util.ArrayList<View>();
                for (int i = 0; i < n; i++) {
                    if (i >= roots.size()) { break; }
                    Object root = roots.get(i);
                    if (root == null) { continue; }
                    Object v;
                    try {
                        v = root.getClass().getMethod("getView").invoke(root);
                    } catch (Throwable t) {
                        if (pass == 0) { cGetViewFail++; }
                        continue;
                    }
                    if (!(v instanceof View)) {
                        if (pass == 0) { cNotView++; }
                        continue;
                    }
                    View view = (View) v;
                    if (pass == 0 && detail.length() < 200) {
                        detail.append('[').append(simple(view)).append('|')
                              .append(view.getTag() == null ? "-" : String.valueOf(view.getTag()))
                              .append('|').append(view.getWidth()).append('x').append(view.getHeight())
                              .append('|').append(view.getParent() == null ? "np" : "p").append(']');
                    }
                    if (view == petView || view == bubbleView) { continue; } // 自己的窗口不动
                    Object tag = view.getTag();
                    String s = tag == null ? "" : String.valueOf(tag);
                    if (TAG_PET.equals(s) || TAG_BUBBLE.equals(s)) {
                        victims.add(view);
                        continue;
                    }
                    // 兜底：早期版本（无 tag）遗留的 overlay WebView 也要清掉。
                    // 只匹配「overlay 类型」窗口，避免误删 Operit 应用内的 WebView（activity 类型）。
                    if (s.length() != 0) {
                        if (pass == 0) { cTagOther++; }
                        continue;
                    }
                    if (!(view instanceof WebView)) {
                        if (pass == 0) { cEmptyNoweb++; }
                        continue;
                    }
                    if (!isStaleOverlay(root, view)) {
                        if (pass == 0) { cEmptyWebNotOverlay++; }
                        continue;
                    }
                    victims.add(view);
                }
                totalVictims += victims.size();
                if (victims.isEmpty()) { break; }
                int removed = 0;
                for (int i = 0; i < victims.size(); i++) {
                    try {
                        // 走公开 API：WindowManager.removeViewImmediate(View)。
                        // 不用 WindowManagerGlobal 反射移除，因为其 removeView 在部分 ROM 上被隐藏 API 限制拦截
                        // （表现为 NoSuchMethodException），而 WindowManager 是公开接口，内部自行处理。
                        w.removeViewImmediate(victims.get(i));
                        removed++;
                    } catch (Throwable t) {
                        if (rmErr.length() == 0) { rmErr = String.valueOf(t); }
                    }
                }
                totalRemoved += removed;
                if (removed == 0) { break; }
            }
            cleanupInfo = "passes=" + passes + " victims=" + totalVictims + " removed=" + totalRemoved
                    + " roots=" + roots.size()
                    + " notView=" + cNotView + " getViewFail=" + cGetViewFail + " tagOther=" + cTagOther
                    + " emptyNoweb=" + cEmptyNoweb + " notOverlay=" + cEmptyWebNotOverlay
                    + " " + detail
                    + (rmErr.length() > 0 ? " rmErr=" + rmErr : "");
        } catch (Throwable t) {
            // 反射失败（如隐藏 API 限制 / 版本差异）时忽略：仅代表本次无法清理，不影响正常显示
            cleanupInfo = "err:" + t;
        }
    }

    private static String simple(View v) {
        String n = v.getClass().getName();
        int i = n.lastIndexOf('.');
        return i >= 0 ? n.substring(i + 1) : n;
    }

    /**
     * 判断某个「无 tag 的 WebView」是否是我们自己（旧 JS 引擎）遗留的 overlay 窗口。
     *
     * 不用 ViewRootImpl 反射读窗口类型（该字段在部分 ROM 被隐藏 API 限制，读不到），改用不依赖隐藏 API 的特征：
     *   1) 直接 addView 进 WindowManager 的顶层 View 没有父容器（getParent()==null）；
     *   2) 尺寸与桌宠（正方形 petSizePx）/ 气泡（bubbleWpx × bubbleHpx）一致。
     * 二者同时满足才判定为我们遗留的窗口，避免误删 Operit 应用内或其它插件的 WebView。
     */
    private static boolean isStaleOverlay(Object root, View view) {
        int w = view.getWidth(), h = view.getHeight();
        // 尺寸与桌宠（正方形 petSizePx）/ 气泡（bubbleWpx × bubbleHpx）一致 —— 这是最可靠的判据：
        // 实测本 ROM 上 addView 进 WindowManager 的 View 也有 parent，不能靠 getParent() 区分。
        boolean petLike = (w == petSizePx && h == petSizePx);
        boolean bubbleLike = (w == bubbleWpx && h == bubbleHpx);
        if (petLike || bubbleLike) { return true; }
        // 尺寸取自旧配置、与当前不一致时，再用窗口类型（overlay）+ 正方形做兜底判定。
        return isOverlayRoot(root) && (w == h) && w > 0;
    }

    /**
     * 判断某个 ViewRootImpl 对应的窗口是否是 overlay 类型（TYPE_APPLICATION_OVERLAY = 2038）。
     * 注意：部分 ROM 会拦截 ViewRootImpl 字段的反射读取，读不到时返回 false（仅作兜底）。
     */
    private static boolean isOverlayRoot(Object root) {
        try {
            java.lang.reflect.Field f = root.getClass().getDeclaredField("mWindowAttributes");
            f.setAccessible(true);
            Object lp = f.get(root);
            if (lp instanceof WindowManager.LayoutParams) {
                return ((WindowManager.LayoutParams) lp).type == 2038;
            }
        } catch (Throwable t) {
        }
        return false;
    }

    private static boolean canOverlay(Context ctx) {
        // android.jar 为 API16，canDrawOverlays 是 API23，故用反射（运行时可解析）。
        try {
            Class<?> cls = Class.forName("android.provider.Settings");
            java.lang.reflect.Method m = cls.getMethod("canDrawOverlays", Context.class);
            Object r = m.invoke(null, ctx);
            return Boolean.TRUE.equals(r);
        } catch (Throwable t) {
            return true; // 无法探测时不阻断（仅在状态里返回信息）
        }
    }

    private static void doShow(Context ctx, String petHtml, String bubbleHtml,
                               int sizeDp, int maxWidthDp, int x, int y, boolean snap) {
        try {
            snapToEdge = snap;
            float density = ctx.getResources().getDisplayMetrics().density;
            petSizePx = Math.max(24, Math.round(sizeDp * density));
            bubbleWpx = Math.max(80, Math.round(maxWidthDp * density));
            bubbleHpx = bubbleWpx;
            slopPx = 12f * density; // 12dp 容差：手指轻点通常有若干像素位移，过小会把戳误判成拖动
            wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);

            // 若存在其它引擎（旧实例）遗留的桌宠窗口，先清掉，避免屏幕上出现多只桌宠
            removeStaleOverlays(ctx);

            if (petView == null) {
                WebView wv = new WebView(ctx);
                wv.setBackgroundColor(0x00000000);
                wv.setLayerType(View.LAYER_TYPE_HARDWARE, null);
                wv.getSettings().setJavaScriptEnabled(true); // 必须：PetBridge 与状态切换都依赖 JS
                try {
                    // 允许无用户手势播放音效（触摸被本层消耗，WebView 判定为无手势）
                    java.lang.reflect.Method m = android.webkit.WebSettings.class.getMethod("setMediaPlaybackRequiresUserGesture", boolean.class);
                    m.invoke(wv.getSettings(), Boolean.FALSE);
                } catch (Throwable t) { }
                wv.getSettings().setDomStorageEnabled(true);
                wv.setVerticalScrollBarEnabled(false);   // 缩放/动画带来的溢出不应画滚动条
                wv.setHorizontalScrollBarEnabled(false);
                wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
                wv.setScrollContainer(false);
                wv.setOnTouchListener(TOUCH);
                petView = wv;
                petView.setTag(TAG_PET);
            }
            petView.loadDataWithBaseURL(DEFAULT_BASE, petHtml, "text/html", "utf-8", null);

            if (bubbleView == null) {
                WebView bv = new WebView(ctx);
                bv.setBackgroundColor(0x00000000);
                bv.setLayerType(View.LAYER_TYPE_HARDWARE, null);
                bv.getSettings().setJavaScriptEnabled(true); // 必须：气泡内容由 PetBridge.showBubble 渲染
                bv.getSettings().setDomStorageEnabled(true);
                bv.setVerticalScrollBarEnabled(false);
                bv.setHorizontalScrollBarEnabled(false);
                bv.setOverScrollMode(View.OVER_SCROLL_NEVER);
                bv.setScrollContainer(false);
                bubbleView = bv;
                bubbleView.setTag(TAG_BUBBLE);
            }
            bubbleView.loadDataWithBaseURL(DEFAULT_BASE, bubbleHtml, "text/html", "utf-8", null);

            SharedPreferences sp = ctx.getSharedPreferences(PREFS, 0);
            int px = x >= 0 ? x : sp.getInt("x", 40);
            int py = y >= 0 ? y : sp.getInt("y", 700);

            if (petLp == null) {
                petLp = new WindowManager.LayoutParams(petSizePx, petSizePx,
                        TYPE_APP_OVERLAY, PET_FLAGS, PixelFormat.TRANSLUCENT);
                petLp.gravity = Gravity.TOP | Gravity.START;
            } else {
                petLp.width = petSizePx;
                petLp.height = petSizePx;
            }
            petLp.x = px;
            petLp.y = py;
            if (petView.getParent() == null) {
                wm.addView(petView, petLp);
            } else {
                wm.updateViewLayout(petView, petLp);
            }

            if (bubbleLp == null) {
                bubbleLp = new WindowManager.LayoutParams(bubbleWpx, bubbleHpx,
                        TYPE_APP_OVERLAY, BUBBLE_FLAGS, PixelFormat.TRANSLUCENT);
                bubbleLp.gravity = Gravity.TOP | Gravity.START;
            } else {
                bubbleLp.width = bubbleWpx;
                bubbleLp.height = bubbleHpx;
            }
            layoutBubble(px, py);
            if (bubbleView.getParent() == null) {
                wm.addView(bubbleView, bubbleLp);
            } else {
                wm.updateViewLayout(bubbleView, bubbleLp);
            }
            bubbleView.setVisibility(View.INVISIBLE);
            bubbleShown = false;
            dragging = false;
            visible = true;
            lastError = "";
            startHeartbeat();
        } catch (Throwable t) {
            lastError = String.valueOf(t);
        }
    }

    private static void doHide() {
        try {
            if (wm != null) {
                if (petView != null && petView.getParent() != null) {
                    wm.removeView(petView);
                }
                if (bubbleView != null && bubbleView.getParent() != null) {
                    wm.removeView(bubbleView);
                }
            }
        } catch (Throwable t) {
            lastError = String.valueOf(t);
        }
        petView = null;
        bubbleView = null;
        petLp = null;
        bubbleLp = null;
        visible = false;
        bubbleShown = false;
        dragging = false;
        stopHeartbeat();
    }

    private static void doApplyConfig(Context ctx, int sizeDp, int maxWidthDp, boolean snap, int x, int y) {
        try {
            float density = ctx.getResources().getDisplayMetrics().density;
            if (sizeDp > 0) {
                petSizePx = Math.max(24, Math.round(sizeDp * density));
            }
            if (maxWidthDp > 0) {
                bubbleWpx = Math.max(80, Math.round(maxWidthDp * density));
                bubbleHpx = bubbleWpx;
            }
            snapToEdge = snap;
            if (petLp == null || bubbleLp == null || petView == null || wm == null) {
                return;
            }
            petLp.width = petSizePx;
            petLp.height = petSizePx;
            if (x >= 0) petLp.x = x;
            if (y >= 0) petLp.y = y;
            if (snapToEdge) {
                petLp.x = nearestEdgeX(ctx.getResources().getDisplayMetrics().widthPixels, petLp.x, petSizePx);
            }
            wm.updateViewLayout(petView, petLp);
            bubbleLp.width = bubbleWpx;
            bubbleLp.height = bubbleHpx;
            layoutBubble(petLp.x, petLp.y);
            wm.updateViewLayout(bubbleView, bubbleLp);
            pendingResized = true;
        } catch (Throwable t) {
            lastError = String.valueOf(t);
        }
    }

    private static void doShowBubble(Context ctx, String linesJson, int durationMs, int maxWidthDp) {
        try {
            if (bubbleView == null || bubbleLp == null || petLp == null) {
                return;
            }
            if (maxWidthDp > 0) {
                float density = ctx.getResources().getDisplayMetrics().density;
                bubbleWpx = Math.max(80, Math.round(maxWidthDp * density));
                bubbleHpx = bubbleWpx;
                bubbleLp.width = bubbleWpx;
                bubbleLp.height = bubbleHpx;
                layoutBubble(petLp.x, petLp.y);
                wm.updateViewLayout(bubbleView, bubbleLp);
            }
            if (linesJson == null || linesJson.length() == 0) {
                linesJson = "[]";
            }
            String call = "window.PetBridge&&PetBridge.showBubble(" + linesJson
                    + ",{durationMs:" + durationMs + ",below:" + bubbleBelow + "})";
            evalJs(bubbleView, call);
            bubbleView.setVisibility(View.VISIBLE);
            bubbleShown = true;
            MAIN.removeCallbacks(hideBubbleRunnable);
            MAIN.postDelayed(hideBubbleRunnable, Math.max(500, durationMs));
        } catch (Throwable t) {
            lastError = String.valueOf(t);
        }
    }

    private static void doHideBubble() {
        try {
            MAIN.removeCallbacks(hideBubbleRunnable);
            if (bubbleView != null) {
                evalJs(bubbleView, "window.PetBridge&&PetBridge.hideBubble()");
                bubbleView.setVisibility(View.INVISIBLE);
            }
        } catch (Throwable t) {
            lastError = String.valueOf(t);
        }
        bubbleShown = false;
    }

    private static final Runnable hideBubbleRunnable = new Runnable() {
        public void run() {
            doHideBubble();
        }
    };

    /** 戳后复位动画状态（由 ACTION_UP 立即排期）。 */
    private static final Runnable idleAnim = new Runnable() {
        public void run() {
            petEvalDirect("window.PetBridge&&PetBridge.setState('idle')");
        }
    };

    /**
     * 长按达到阈值：判定为「长按」（该手势不再产生戳击），并给出强震动反馈。
     * 由 ACTION_DOWN 排期；ACTION_MOVE 走出拖动容差或 ACTION_UP 时取消。
     */
    private static final Runnable longPressRunnable = new Runnable() {
        public void run() {
            if (dragging || touchView == null) { return; }
            longPressFired = true;
            pendingLongPress = true;
            petEvalDirect("window.PetBridge&&PetBridge.setState('press')");
            try { doVibrate(touchView.getContext(), 45); } catch (Throwable t) { }
        }
    };

    private static void layoutBubble(int petX, int petY) {
        if (bubbleLp == null) {
            return;
        }
        int anchorX = petX + Math.round(petSizePx * 0.12f);
        int anchorY = petY + Math.round(petSizePx * 0.10f);
        // 固定：永远在鲸鱼左上角，气泡尾巴指向该锚点。不夹取 y，保证任何位置都不与鲸鱼脱开
        // （鲸鱼非常靠顶时气泡会向上超出屏幕被裁切，这是"永远左上角"的必然代价）
        bubbleBelow = false;
        int bx = anchorX - bubbleWpx / 2;
        int by = anchorY - bubbleHpx + Math.round(bubbleHpx * 0.10f);
        if (bx < 0) {
            bx = 0; // 仅水平方向夹取，保证文字不被左边缘裁掉
        }
        bubbleLp.x = bx;
        bubbleLp.y = by;
    }

    private static int nearestEdgeX(int screenW, int x, int sizePx) {
        int left = Math.max(0, Math.min(x, screenW - sizePx));
        return (left + sizePx / 2 < screenW / 2) ? 0 : Math.max(0, screenW - sizePx);
    }

    private static void doVibrate(Context ctx, int ms) {
        try {
            if (ctx.checkCallingOrSelfPermission("android.permission.VIBRATE")
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                return; // 宿主未声明 VIBRATE 权限时静默跳过，避免污染 lastError
            }
            Vibrator vb = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (vb != null) {
                vb.vibrate(ms);
            }
        } catch (Throwable t) {
            lastError = String.valueOf(t);
        }
    }

    private static void startHeartbeat() {
        if (heartbeat != null) {
            return;
        }
        heartbeat = new Runnable() {
            public void run() {
                tick++;
                if (visible) {
                    MAIN.postDelayed(this, 1000);
                } else {
                    heartbeat = null;
                }
            }
        };
        MAIN.postDelayed(heartbeat, 1000);
    }

    private static void stopHeartbeat() {
        if (heartbeat != null) {
            MAIN.removeCallbacks(heartbeat);
            heartbeat = null;
        }
    }

    /** 极简 JSON 字符串转义。 */
    private static String jstr(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder(s.length() + 8);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    // ==================== 触摸 ====================

    private static final View.OnTouchListener TOUCH = new View.OnTouchListener() {
        public boolean onTouch(View v, MotionEvent e) {
            if (petLp == null) {
                return false;
            }
            int a = e.getActionMasked();
            if (a == MotionEvent.ACTION_DOWN) {
                downX = e.getRawX();
                downY = e.getRawY();
                startX = petLp.x;
                startY = petLp.y;
                dragging = false;
                longPressFired = false;
                touchView = v;
                MAIN.removeCallbacks(longPressRunnable);
                MAIN.postDelayed(longPressRunnable, LONG_PRESS_MS);
                // Q弹：按下即时反馈（压弹动画 + 按压音），不等松手
                petEvalDirect("window.PetBridge&&PetBridge.press()");
                return true;
            }
            if (a == MotionEvent.ACTION_MOVE) {
                if (longPressFired) { return true; } // 已判定长按，忽略后续移动
                float dx = e.getRawX() - downX;
                float dy = e.getRawY() - downY;
                float sl = slopPx;
                if (!dragging && (dx * dx + dy * dy) > sl * sl) {
                    dragging = true;
                    MAIN.removeCallbacks(longPressRunnable); // 开始拖动 → 取消长按
                    petEvalDirect("window.PetBridge&&PetBridge.setDragging(true)");
                }
                if (dragging && petView != null && wm != null) {
                    petLp.x = startX + (int) dx;
                    petLp.y = startY + (int) dy;
                    // 夹取在屏幕内，避免把鲸鱼拖出屏幕丢失
                    int screenW = v.getContext().getResources().getDisplayMetrics().widthPixels;
                    int screenH = v.getContext().getResources().getDisplayMetrics().heightPixels;
                    if (petLp.x < 0) { petLp.x = 0; }
                    if (petLp.y < 0) { petLp.y = 0; }
                    if (petLp.x > screenW - petSizePx) { petLp.x = screenW - petSizePx; }
                    if (petLp.y > screenH - petSizePx) { petLp.y = screenH - petSizePx; }
                    try {
                        wm.updateViewLayout(petView, petLp);
                        if (bubbleView != null && bubbleShown) {
                            layoutBubble(petLp.x, petLp.y);
                            wm.updateViewLayout(bubbleView, bubbleLp);
                        }
                    } catch (Throwable t) {
                    }
                }
                return true;
            }
            if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) {
                MAIN.removeCallbacks(longPressRunnable);
                if (dragging) {
                    dragging = false;
                    petEvalDirect("window.PetBridge&&PetBridge.setDragging(false)");
                    try {
                        SharedPreferences sp = v.getContext().getSharedPreferences(PREFS, 0);
                        if (snapToEdge) {
                            int screenW = v.getContext().getResources().getDisplayMetrics().widthPixels;
                            petLp.x = nearestEdgeX(screenW, petLp.x, petSizePx);
                            wm.updateViewLayout(petView, petLp);
                            layoutBubble(petLp.x, petLp.y);
                            wm.updateViewLayout(bubbleView, bubbleLp);
                        }
                        sp.edit().putInt("x", petLp.x).putInt("y", petLp.y).apply();
                    } catch (Throwable t) {
                    }
                    pendingDragEnd = true;
                    dragEndX = petLp.x;
                    dragEndY = petLp.y;
                } else if (longPressFired) {
                    longPressFired = false;
                    petEvalDirect("window.PetBridge&&PetBridge.setState('idle')");
                    // 长按手势：不产生戳击事件（隐藏由 JS 收到 longPress 后执行）
                } else {
                    pendingPoke = true;
                    doVibrate(v.getContext(), 25);
                    petEvalDirect("window.PetBridge&&PetBridge.release()");
                    // 立即视觉反馈：不等 JS 轮询（原实现最坏有 1s 延迟）
                    petEvalDirect("window.PetBridge&&PetBridge.setState('press')");
                    MAIN.removeCallbacks(idleAnim);
                    MAIN.postDelayed(idleAnim, 300);
                }
                return true;
            }
            return false;
        }
    };

    /** 已在主线程时直接注入，避免重复 post。 */
    private static void petEvalDirect(String js) {
        if (petView != null) {
            evalJs(petView, js);
        }
    }

    /** 优先用 evaluateJavascript（API19，反射调用），失败回退 loadUrl。 */
    private static void evalJs(WebView wv, String js) {
        try {
            java.lang.reflect.Method m = WebView.class.getMethod("evaluateJavascript", String.class, android.webkit.ValueCallback.class);
            m.invoke(wv, js, null);
        } catch (Throwable t) {
            try {
                wv.loadUrl("javascript:" + js);
            } catch (Throwable t2) {
            }
        }
    }
}