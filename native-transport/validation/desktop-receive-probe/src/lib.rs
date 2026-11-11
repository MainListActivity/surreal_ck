//! 只检查候选平台后端。不绕过生产receive_supported，不引入WebRTC构建。
#![cfg(any(target_os = "macos", windows))]
#![allow(dead_code)]

#[cfg(target_os = "macos")]
#[path = "../../../src/transfer_destination_macos.rs"]
mod destination;

#[cfg(windows)]
#[path = "../../../src/transfer_destination_windows.rs"]
mod destination;
