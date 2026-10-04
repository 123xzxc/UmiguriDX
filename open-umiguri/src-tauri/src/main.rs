// main.rs - 桌面入口(移动端走 lib.rs 的 mobile_entry_point)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ⚠ 必须最先执行: WebKitGTK 的 EGL 探测发生在极早期, 一旦它先失败进程就直接 abort,
    //   后面再设环境变量也来不及。这里比 run() 里的调用更早(进程入口第一句)。
    umiguri_lib::linux_prepare_env();
    umiguri_lib::run()
}
