use std::{fs, io, path::{Path, PathBuf}};

pub fn directory() -> io::Result<PathBuf> {
    if let Some(path) = std::env::var_os("SUMMON_TEST_DATA_DIR") { return Ok(path.into()); }
    std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("Reed"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "APPDATA unavailable"))
}

pub fn prepare() -> io::Result<PathBuf> {
    let target = directory()?;
    let legacy = if std::env::var_os("SUMMON_TEST_DATA_DIR").is_some() {
        std::env::var_os("SUMMON_TEST_LEGACY_DIR").map(PathBuf::from)
    } else { std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("dev.rynorca.summon")) };
    if let Some(source) = legacy.filter(|p| p.is_dir()) { migrate(&source, &target)?; }
    fs::create_dir_all(&target)?;
    Ok(target)
}

fn check_regular(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt;
      if meta.file_attributes() & 0x400 != 0 { return Err(io::Error::other("Profile contains a junction or symbolic link")); } }
    if meta.file_type().is_symlink() { return Err(io::Error::other("Profile contains a symbolic link")); }
    Ok(())
}

fn rewrite(value: &mut serde_json::Value, source: &Path, target: &Path) {
    match value {
        serde_json::Value::String(s) => {
            let old = source.to_string_lossy();
            let prefix = s.get(..old.len());
            if prefix.map(|p| p.eq_ignore_ascii_case(&old)).unwrap_or(false)
                && (s.len() == old.len() || s.as_bytes().get(old.len()).map(|b| *b == b'/' || *b == b'\\').unwrap_or(false)) {
                *s = format!("{}{}", target.display(), &s[old.len()..]);
            }
        }
        serde_json::Value::Array(items) => for item in items { rewrite(item, source, target); },
        serde_json::Value::Object(items) => for item in items.values_mut() { rewrite(item, source, target); },
        _ => {}
    }
}

fn copy_tree(source: &Path, destination: &Path, old: &Path, new: &Path) -> io::Result<()> {
    check_regular(source)?;
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?; let path = entry.path(); let name = entry.file_name();
        if name.to_string_lossy().ends_with(".lock") || name.to_string_lossy().ends_with(".tmp") { continue; }
        check_regular(&path)?;
        let dest = destination.join(name);
        if path.is_dir() { copy_tree(&path, &dest, old, new)?; }
        else {
            let bytes = fs::read(&path)?;
            let content = match path.extension().and_then(|e| e.to_str()) {
                Some("json") => {
                    let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
                    rewrite(&mut value, old, new); serde_json::to_vec_pretty(&value).map_err(io::Error::other)?
                }
                Some("jsonl") => {
                    let text = std::str::from_utf8(&bytes).map_err(io::Error::other)?;
                    let mut output = String::new();
                    for line in text.lines() {
                        if line.trim().is_empty() { output.push('\n'); continue; }
                        let mut value: serde_json::Value = serde_json::from_str(line).map_err(io::Error::other)?;
                        rewrite(&mut value, old, new);
                        output.push_str(&serde_json::to_string(&value).map_err(io::Error::other)?); output.push('\n');
                    }
                    output.into_bytes()
                }
                _ => bytes,
            };
            fs::write(dest, content)?;
        }
    }
    Ok(())
}

pub fn migrate(source: &Path, target: &Path) -> io::Result<bool> {
    check_regular(source)?;
    if target.exists() {
        check_regular(target)?;
        if fs::read_dir(target)?.next().is_some() { return Ok(false); }
    }
    let parent = target.parent().ok_or_else(|| io::Error::other("Invalid profile path"))?;
    fs::create_dir_all(parent)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(io::Error::other)?.as_nanos();
    let staging = parent.join(format!("Reed.migrating-{}-{stamp}", std::process::id()));
    copy_tree(source, &staging, source, target)?;
    if staging.join(".window-state.json").exists() && !staging.join("window-state.json").exists() {
        fs::rename(staging.join(".window-state.json"), staging.join("window-state.json"))?;
    }
    fs::write(staging.join("migration.json"), serde_json::to_vec_pretty(&serde_json::json!({"version":1,"source":source,"backupPreserved":true})).map_err(io::Error::other)?)?;
    if target.exists() { fs::remove_dir(target)?; } // Only an empty directory can be removed.
    fs::rename(staging, target)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let p = std::env::temp_dir().join(format!("reed-profile-test-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&p).unwrap(); p
    }
    #[test]
    fn migration_preserves_backup_keys_and_external_paths() {
        let root=fixture(); let old=root.join("old"); let new=root.join("Reed");
        fs::create_dir_all(old.join("agent")).unwrap(); fs::create_dir_all(old.join("sessions")).unwrap();
        let config=serde_json::json!({"skill":old.join("skills/a"),"vault":"D:\\Notes","notPrefix":format!("{}-other",old.display())});
        fs::write(old.join("user-config.json"),config.to_string()).unwrap();
        fs::write(old.join("agent/key.dpapi"),[0,255,4,8]).unwrap();
        fs::write(old.join(".window-state.json"),"{}").unwrap();
        fs::write(old.join("sessions/a.jsonl"),serde_json::json!({"cwd":old.join("workspace"),"text":"hello"}).to_string()).unwrap();
        assert!(migrate(&old,&new).unwrap());
        assert_eq!(fs::read(new.join("agent/key.dpapi")).unwrap(),[0,255,4,8]);
        assert_eq!(fs::read_to_string(old.join("user-config.json")).unwrap(),config.to_string());
        let migrated:serde_json::Value=serde_json::from_slice(&fs::read(new.join("user-config.json")).unwrap()).unwrap();
        assert_eq!(migrated["skill"],new.join("skills/a").to_string_lossy().as_ref()); assert_eq!(migrated["vault"],config["vault"]); assert_eq!(migrated["notPrefix"],config["notPrefix"]);
        assert!(new.join("window-state.json").exists());
        assert!(fs::read_to_string(new.join("sessions/a.jsonl")).unwrap().contains("Reed"));
        assert!(!migrate(&old,&new).unwrap());
    }
    #[test]
    fn invalid_config_does_not_publish_partial_profile() {
        let root=fixture();let old=root.join("old");let new=root.join("Reed");fs::create_dir(&old).unwrap();
        fs::write(old.join("user-config.json"),"invalid").unwrap();
        assert!(migrate(&old,&new).is_err());assert!(!new.exists());assert!(old.join("user-config.json").exists());
    }
    #[test]
    fn existing_profile_is_not_overwritten() {
        let root=fixture();let old=root.join("old");let new=root.join("Reed");fs::create_dir(&old).unwrap();fs::create_dir(&new).unwrap();
        fs::write(new.join("keep"),"new data").unwrap();assert!(!migrate(&old,&new).unwrap());assert_eq!(fs::read_to_string(new.join("keep")).unwrap(),"new data");
    }
}
