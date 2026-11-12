fn main() {
    println!("cargo:rerun-if-env-changed=SURREAL_UPDATE_CONFIG_JSON");
}
