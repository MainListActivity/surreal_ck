fn main() {
    let inventory = surreal_ck_native_media_platform::devices::discover();
    println!("camera_permission={:?}", inventory.camera);
    println!("microphone_permission={:?}", inventory.microphone);
    println!("devices={}", inventory.devices.len());
    for device in inventory.devices {
        println!("{:?}: {} ({})", device.kind, device.name, device.id);
    }
}
