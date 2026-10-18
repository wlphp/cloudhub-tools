//! Bounded Claude workspace file operations. Never starts MCP servers or skill code.
use super::{crypto::{decrypt_secret,encrypt_secret},database::open_db,repositories::claude_providers as repo};
use rusqlite::{params,OptionalExtension};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::{fs,io::Read,path::{Path,PathBuf}};

const LIBRARY:&str="claude.workbench.library";
const PROJECT:&str="claude.workbench.project";
#[derive(Clone,Default,Serialize,Deserialize)]
#[serde(rename_all="camelCase",default)]
struct Library{disabled_mcp:serde_json::Map<String,Value>,prompts:Vec<Prompt>,active_prompt:Option<String>}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Prompt{pub id:String,pub name:String,pub content:String}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Mcp{pub name:String,pub enabled:bool,pub transport:String,pub command:String,pub url:String,pub has_secrets:bool}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Skill{pub name:String,pub description:String,pub trashed:bool,pub key:String}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Session{pub key:String,pub id:String,pub title:String,pub project:String,pub modified_at:u64,pub bytes:u64,pub trashed:bool}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Snapshot{
    pub project:Option<String>,pub settings_path:String,pub mcp_path:String,pub prompt_path:String,
    pub mcp:Vec<Mcp>,pub prompts:Vec<Prompt>,pub active_prompt:Option<String>,pub skills:Vec<Skill>,
    pub sessions:Vec<Session>,pub environment_conflicts:Vec<String>,
}
fn pref(key:&str)->Result<Option<String>,String>{open_db()?.query_row("SELECT value FROM client_preferences WHERE key=?1",[key],|r|r.get(0)).optional().map_err(|_|"读取工作台数据失败".into())}
fn set_pref(key:&str,value:&str)->Result<(),String>{
    open_db()?.execute("INSERT INTO client_preferences(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![key,value,chrono::Utc::now().timestamp_millis()]).map_err(|_|"保存工作台数据失败")?;Ok(())
}
pub fn project()->Result<Option<PathBuf>,String>{pref(PROJECT)?.filter(|s|!s.is_empty()).map(|s|{
    let path=PathBuf::from(s);if !path.is_absolute()||!path.is_dir(){Err("所选项目目录不可用，请重新选择".into())}else{Ok(path)}
}).transpose()}
pub fn settings_path()->Result<PathBuf,String>{Ok(if let Some(root)=project()?{root.join(".claude/settings.local.json")}else{repo::claude_home()?.join("settings.json")})}
pub fn set_project(path:Option<PathBuf>)->Result<(),String>{
    let value=if let Some(path)=path{let root=path.canonicalize().map_err(|_|"项目目录不可用")?;if !root.is_dir(){return Err("请选择项目文件夹".into());}root.to_string_lossy().to_string()}else{String::new()};
    set_pref(PROJECT,&value)
}
fn mcp_path()->Result<PathBuf,String>{Ok(if let Some(root)=project()?{root.join(".mcp.json")}else{repo::claude_home()?.parent().ok_or("用户目录不可用")?.join(".claude.json")})}
fn prompt_path()->Result<PathBuf,String>{Ok(if let Some(root)=project()?{root.join("CLAUDE.md")}else{repo::claude_home()?.join("CLAUDE.md")})}
fn library()->Result<Library,String>{
    pref(&library_key()?)?.map(|cipher|serde_json::from_str(&decrypt_secret(&cipher)?).map_err(|_|"工作台数据损坏".into())).unwrap_or_else(||Ok(Library::default()))
}
fn library_key()->Result<String,String>{Ok(format!("{LIBRARY}.{}",backup_key(&mcp_path()?)))}
fn project_in(conn:&rusqlite::Connection)->Result<Option<PathBuf>,String>{
    let value:Option<String>=conn.query_row("SELECT value FROM client_preferences WHERE key=?1",[PROJECT],|r|r.get(0)).optional().map_err(|_|"读取工作台数据失败")?;
    Ok(value.filter(|p|!p.is_empty()).map(PathBuf::from))
}
fn current_key(conn:&rusqlite::Connection)->Result<String,String>{
    let path=if let Some(root)=project_in(conn)?{root.join(".claude/settings.local.json")}else{repo::claude_home()?.join("settings.json")};
    Ok(format!("claude.workbench.current.{}",backup_key(&path)))
}
pub fn current_provider(conn:&rusqlite::Connection)->Result<Option<String>,String>{
    let value:Option<String>=conn.query_row("SELECT value FROM client_preferences WHERE key=?1",[current_key(conn)?],|r|r.get(0)).optional().map_err(|_|"读取当前供应商失败")?;
    if let Some(value)=value{return Ok((!value.is_empty()).then_some(value));}
    if project_in(conn)?.is_none(){repo::current_provider_id(conn)}else{Ok(None)}
}
pub fn set_current_provider(conn:&rusqlite::Connection,id:Option<&str>)->Result<(),String>{
    conn.execute("INSERT INTO client_preferences(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![current_key(conn)?,id.unwrap_or(""),chrono::Utc::now().timestamp_millis()]).map_err(|_|"更新当前供应商失败")?;
    if project_in(conn)?.is_none(){
        if let Some(id)=id{repo::set_current(conn,id)?;}else{conn.execute("UPDATE claude_providers SET is_current=0",[]).map_err(|_|"更新当前供应商失败")?;}
    }
    Ok(())
}
fn save_library(value:&Library)->Result<(),String>{set_pref(&library_key()?,&encrypt_secret(&serde_json::to_string(value).map_err(|_|"工作台数据无效")?)?)}
fn read(path:&Path,max:u64)->Result<Option<Vec<u8>>,String>{
    if !path.exists(){return Ok(None);}
    let meta=fs::symlink_metadata(path).map_err(|_|"读取 Claude 文件失败")?;
    if meta.file_type().is_symlink()||!meta.is_file()||meta.len()>max{return Err("Claude 文件超过限制或是链接，未读取".into());}
    let mut bytes=Vec::new();fs::File::open(path).and_then(|f|f.take(max+1).read_to_end(&mut bytes)).map_err(|_|"读取 Claude 文件失败")?;
    if bytes.len() as u64>max{return Err("Claude 文件超过大小限制".into());}Ok(Some(bytes))
}
fn read_json(path:&Path)->Result<Value,String>{
    let Some(bytes)=read(path,8*1024*1024)?else{return Ok(json!({}));};
    let value:Value=serde_json::from_slice(&bytes).map_err(|_|"Claude 文件不是合法 JSON，未改写")?;
    if !value.is_object(){return Err("Claude 配置必须是对象，未改写".into());}Ok(value)
}
fn backup_key(path:&Path)->String{use sha2::{Digest,Sha256};format!("claude.workbench.file.{}",hex::encode(Sha256::digest(path.to_string_lossy().as_bytes())))}
fn write(path:&Path,bytes:&[u8],backup:bool)->Result<(),String>{
    if let Some(parent)=path.parent(){fs::create_dir_all(parent).map_err(|_|"创建 Claude 配置目录失败")?;}
    if path.symlink_metadata().is_ok_and(|m|m.file_type().is_symlink()){return Err("不能改写链接文件".into());}
    if backup{let old=read(path,8*1024*1024)?;let record=json!({"exists":old.is_some(),"bytes":old.map(hex::encode)});set_pref(&backup_key(path),&encrypt_secret(&record.to_string())?)?;}
    let tmp=path.with_extension(format!("cloudhub-{}.tmp",uuid::Uuid::new_v4()));
    fs::write(&tmp,bytes).map_err(|_|"写入 Claude 文件失败")?;
    fs::rename(&tmp,path).map_err(|_|"保存 Claude 文件失败")?;Ok(())
}
fn valid_name(name:&str)->bool{!name.is_empty()&&name.len()<=100&&name.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_.".contains(&b))&&name!="."&&name!=".."}
fn server_summary(name:&str,v:&Value,enabled:bool)->Mcp{
    let url=v["url"].as_str().and_then(|s|reqwest::Url::parse(s).ok()).map(|mut u|{
        let _=u.set_username("");let _=u.set_password(None);u.set_query(None);u.set_fragment(None);u.to_string()
    }).unwrap_or_default();
    Mcp{name:name.into(),enabled,transport:v["type"].as_str().unwrap_or("stdio").into(),command:v["command"].as_str().filter(|s|s.len()<240).unwrap_or("").into(),url,has_secrets:v["env"].as_object().is_some_and(|v|!v.is_empty())||v["headers"].as_object().is_some_and(|v|!v.is_empty())}
}
pub fn snapshot()->Result<Snapshot,String>{
    let library=library()?;let mcp_path=mcp_path()?;let doc=read_json(&mcp_path)?;
    let mut mcp:Vec<_>=doc["mcpServers"].as_object().into_iter().flatten().map(|(k,v)|server_summary(k,v,true)).collect();
    mcp.extend(library.disabled_mcp.iter().filter(|(k,_)|doc["mcpServers"].get(*k).is_none()).map(|(k,v)|server_summary(k,v,false)));mcp.sort_by(|a,b|a.name.cmp(&b.name));
    let conflicts=["ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_USE_BEDROCK","CLAUDE_CODE_USE_VERTEX"].into_iter().filter(|k|std::env::var(k).is_ok_and(|v|!v.is_empty())).map(String::from).collect();
    Ok(Snapshot{project:project()?.map(|p|p.to_string_lossy().to_string()),settings_path:settings_path()?.to_string_lossy().to_string(),mcp_path:mcp_path.to_string_lossy().to_string(),prompt_path:prompt_path()?.to_string_lossy().to_string(),mcp,prompts:library.prompts,active_prompt:library.active_prompt,skills:skills()?,sessions:sessions()?,environment_conflicts:conflicts})
}
#[derive(Deserialize)]
#[serde(tag="type",rename_all="snake_case",deny_unknown_fields)]
pub enum Action{
    SaveMcp{name:String,config:Value},
    ToggleMcp{name:String,enabled:bool},
    DeleteMcp{name:String},
    SavePrompt{prompt:Prompt},
    DeletePrompt{id:String},
    ActivatePrompt{id:String},
    RestoreFile{kind:String},
    TrashSkill{key:String},
    RestoreSkill{key:String},
    TrashSession{key:String},
    RestoreSession{key:String},
}
pub fn act(action:Action)->Result<(),String>{
    let mut lib=library()?;
    match action{
        Action::SaveMcp{name,mut config}=>{
            if !valid_name(&name)||!config.is_object()||config.to_string().len()>65536{return Err("MCP 名称或配置无效".into());}
            let kind=config["type"].as_str().unwrap_or("stdio");
            if kind=="stdio"{
                if config["command"].as_str().is_none_or(|s|s.trim().is_empty()||s.len()>1024)||config.get("args").is_some_and(|a|!a.is_array()||a.as_array().is_some_and(|a|a.len()>100||a.iter().any(|v|!v.is_string()))){return Err("MCP 命令或参数无效".into());}
            }else if matches!(kind,"http"|"sse"){super::claude_gateway::validate_url(config["url"].as_str().unwrap_or(""))?;}else{return Err("MCP 传输类型无效".into());}
            for key in ["env","headers"]{if config.get(key).is_some_and(|v|!v.is_object()||v.as_object().is_some_and(|m|m.len()>100||m.values().any(|v|!v.is_string()))){return Err("MCP 环境变量或请求头无效".into());}}
            let path=mcp_path()?;let mut doc=read_json(&path)?;
            let previous=doc["mcpServers"].get(&name).or_else(||lib.disabled_mcp.get(&name));
            let original_url=previous.filter(|p|config["url"].as_str()==Some(server_summary(&name,p,true).url.as_str())).and_then(|p|p.get("url")).cloned();
            if let Some(previous)=previous.filter(|p|p["type"].as_str().unwrap_or("stdio")==kind){
                for key in ["args","env","headers"]{if config.get(key).is_none(){if let Some(v)=previous.get(key){config[key]=v.clone();}}}
            }
            if let Some(url)=original_url{config["url"]=url;}
            doc.as_object_mut().unwrap().entry("mcpServers").or_insert(json!({})).as_object_mut().ok_or("mcpServers 必须是对象")?.insert(name.clone(),config);
            write(&path,doc.to_string().as_bytes(),true)?;lib.disabled_mcp.remove(&name);
        }
        Action::ToggleMcp{name,enabled}=>{
            let path=mcp_path()?;let mut doc=read_json(&path)?;
            let servers=doc.as_object_mut().unwrap().entry("mcpServers").or_insert(json!({})).as_object_mut().ok_or("mcpServers 必须是对象")?;
            if enabled{let value=lib.disabled_mcp.remove(&name).ok_or("未找到停用的 MCP")?;servers.insert(name,value);}
            else{
                let value=servers.remove(&name).ok_or("未找到 MCP")?;lib.disabled_mcp.insert(name,value);
                // Persist the encrypted copy before removing the live entry so interrupted disables cannot lose it.
                save_library(&lib)?;
            }
            write(&path,doc.to_string().as_bytes(),true)?;
        }
        Action::DeleteMcp{name}=>{
            let path=mcp_path()?;let mut doc=read_json(&path)?;
            if let Some(servers)=doc["mcpServers"].as_object_mut(){servers.remove(&name);}
            write(&path,doc.to_string().as_bytes(),true)?;lib.disabled_mcp.remove(&name);
        }
        Action::SavePrompt{prompt}=>{
            if !valid_name(&prompt.id)||prompt.name.trim().is_empty()||prompt.name.len()>240||prompt.content.len()>512*1024||lib.prompts.len()>=100&&!lib.prompts.iter().any(|p|p.id==prompt.id){return Err("提示词名称、内容或数量无效".into());}
            lib.prompts.retain(|p|p.id!=prompt.id);
            if lib.active_prompt.as_deref()==Some(&prompt.id){write(&prompt_path()?,prompt.content.as_bytes(),true)?;}
            lib.prompts.push(prompt);
        }
        Action::DeletePrompt{id}=>{
            if lib.active_prompt.as_deref()==Some(&id){return Err("请先启用其他提示词或恢复 CLAUDE.md，再删除当前提示词".into());}
            lib.prompts.retain(|p|p.id!=id);
        }
        Action::ActivatePrompt{id}=>{
            let p=lib.prompts.iter().find(|p|p.id==id).ok_or("提示词不存在")?;
            write(&prompt_path()?,p.content.as_bytes(),true)?;lib.active_prompt=Some(id);
        }
        Action::RestoreFile{kind}=>{
            let path=match kind.as_str(){"mcp"=>mcp_path()?,"prompt"=>prompt_path()?,_=>return Err("恢复目标无效".into())};
            let raw=pref(&backup_key(&path))?.ok_or("没有可恢复的文件备份")?;
            let record:Value=serde_json::from_str(&decrypt_secret(&raw)?).map_err(|_|"文件备份无效")?;
            if record["exists"]==true{let bytes=hex::decode(record["bytes"].as_str().ok_or("备份内容无效")?).map_err(|_|"备份内容无效")?;write(&path,&bytes,false)?;}
            else if path.exists(){fs::remove_file(&path).map_err(|_|"恢复文件失败")?;}
            if kind=="prompt"{lib.active_prompt=None;}
        }
        Action::TrashSkill{key}=>{
            if !valid_name(&key){return Err("技能标识无效".into());}
            let root=skill_root()?;let source=root.join(&key);
            check_tree(&source,&mut 0,&mut 0)?;
            let trash=skill_trash(&root)?;
            fs::rename(source,trash.join(format!("{key}--{}",chrono::Utc::now().timestamp_millis()))).map_err(|_|"备份技能失败")?;
        }
        Action::RestoreSkill{key}=>{
            if !valid_name(&key){return Err("技能备份标识无效".into());}
            let(name,_)=key.rsplit_once("--").ok_or("技能备份标识无效")?;
            let root=skill_root()?;let source=skill_trash(&root)?.join(&key);
            check_tree(&source,&mut 0,&mut 0)?;
            if root.join(name).exists(){return Err("同名技能已存在，无法覆盖".into());}
            fs::rename(source,root.join(name)).map_err(|_|"恢复技能失败")?;
        }
        Action::TrashSession{key}=>{let path=session_path(&key,false)?;let target=path.with_extension("jsonl.cloudhub-trash");if target.exists(){return Err("同名会话备份已存在".into());}fs::rename(&path,target).map_err(|_|"移入会话回收站失败")?;}
        Action::RestoreSession{key}=>{let path=session_path(&key,true)?;let target=path.with_extension("").with_extension("jsonl");if target.exists(){return Err("同名会话已存在".into());}fs::rename(path,target).map_err(|_|"恢复会话失败")?;}
    }
    save_library(&lib)
}
fn skills()->Result<Vec<Skill>,String>{
    let root=repo::claude_home()?.join("skills");let mut result=Vec::new();
    for (path,trashed) in [(root.clone(),false),(root.join(".cloudhub-trash"),true)]{
        let Ok(entries)=fs::read_dir(path)else{continue;};
        for entry in entries.take(300).flatten(){
            if !entry.file_type().is_ok_and(|t|t.is_dir()&&!t.is_symlink()){continue;}
            let key=entry.file_name().to_string_lossy().to_string();if key.starts_with('.')||!valid_name(&key){continue;}
            let data=read(&entry.path().join("SKILL.md"),512*1024).ok().flatten().unwrap_or_default();
            let text=String::from_utf8_lossy(&data);
            let description=text.lines().find_map(|l|l.strip_prefix("description:")).unwrap_or("").trim().trim_matches('"').chars().take(240).collect();
            result.push(Skill{name:if trashed{key.rsplit_once("--").map(|p|p.0).unwrap_or(&key).into()}else{key.clone()},description,trashed,key});
        }
    }Ok(result)
}
fn check_tree(path:&Path,count:&mut usize,size:&mut u64)->Result<(),String>{
    let m=fs::symlink_metadata(path).map_err(|_|"无法读取技能文件")?;
    if m.file_type().is_symlink(){return Err("技能包含链接，不能自动复制或移动".into());}
    *count+=1;*size+=m.len();
    if *count>1000||*size>20*1024*1024{return Err("技能文件数量或大小超过限制".into());}
    if m.is_dir(){for e in fs::read_dir(path).map_err(|_|"无法读取技能目录")?{check_tree(&e.map_err(|_|"无法读取技能条目")?.path(),count,size)?;}}Ok(())
}
fn skill_root()->Result<PathBuf,String>{
    let root=repo::claude_home()?.join("skills");
    fs::create_dir_all(&root).map_err(|_|"创建技能目录失败")?;
    if fs::symlink_metadata(&root).map_err(|_|"读取技能目录失败")?.file_type().is_symlink(){return Err("技能目录不能是链接".into());}
    root.canonicalize().map_err(|_|"技能目录不可用".into())
}
fn skill_trash(root:&Path)->Result<PathBuf,String>{
    let trash=root.join(".cloudhub-trash");fs::create_dir_all(&trash).map_err(|_|"创建技能备份失败")?;
    if fs::symlink_metadata(&trash).map_err(|_|"读取技能目录失败")?.file_type().is_symlink(){return Err("技能回收站不能是链接".into());}
    let resolved=trash.canonicalize().map_err(|_|"技能目录不可用")?;
    if !resolved.starts_with(root){return Err("技能回收站路径无效".into());}
    Ok(resolved)
}
fn copy_tree(from:&Path,to:&Path)->Result<(),String>{
    let meta=fs::symlink_metadata(from).map_err(|_|"读取技能失败")?;
    if meta.file_type().is_symlink(){return Err("技能包含链接，不能自动复制或移动".into());}
    if meta.is_dir(){fs::create_dir(to).map_err(|_|"创建技能目录失败")?;for entry in fs::read_dir(from).map_err(|_|"读取技能失败")?{let e=entry.map_err(|_|"读取技能失败")?;copy_tree(&e.path(),&to.join(e.file_name()))?;}}
    else{fs::copy(from,to).map_err(|_|"复制技能文件失败")?;}Ok(())
}
pub fn install_skill(source:PathBuf)->Result<(),String>{
    let source=source.canonicalize().map_err(|_|"技能目录不可用")?;
    let name=source.file_name().and_then(|s|s.to_str()).filter(|s|valid_name(s)).ok_or("技能文件夹名称无效")?;
    if read(&source.join("SKILL.md"),512*1024)?.is_none(){return Err("所选目录没有 SKILL.md".into());}
    check_tree(&source,&mut 0,&mut 0)?;
    let root=skill_root()?;
    if root.join(name).exists(){return Err("同名技能已存在，请先卸载或改名".into());}
    let staging=root.join(format!(".install-{}",uuid::Uuid::new_v4()));
    copy_tree(&source,&staging)?;
    fs::rename(staging,root.join(name)).map_err(|_|"安装技能失败")?;Ok(())
}
fn sessions()->Result<Vec<Session>,String>{
    let root=repo::claude_home()?.join("projects");let mut result=Vec::new();
    let Ok(projects)=fs::read_dir(root)else{return Ok(result);};
    for project in projects.take(100).flatten(){
        if !project.file_type().is_ok_and(|t|t.is_dir()&&!t.is_symlink()){continue;}
        let Ok(files)=fs::read_dir(project.path())else{continue;};
        for file in files.take(2000).flatten(){
            if !file.file_type().is_ok_and(|t|t.is_file()&&!t.is_symlink()){continue;}
            let name=file.file_name().to_string_lossy().to_string();let trashed=name.ends_with(".jsonl.cloudhub-trash");
            if !trashed&&!name.ends_with(".jsonl"){continue;}
            let id=name.trim_end_matches(".cloudhub-trash").trim_end_matches(".jsonl");
            if uuid::Uuid::parse_str(id).is_err(){continue;}
            let meta=file.metadata().map_err(|_|"读取会话信息失败")?;
            let mut bytes=Vec::new();if let Ok(f)=fs::File::open(file.path()){let _=f.take(128*1024).read_to_end(&mut bytes);}
            let title=String::from_utf8_lossy(&bytes).lines().take(100).filter_map(|l|serde_json::from_str::<Value>(l).ok()).find(|v|v["type"]=="user").map(|v|{
                v["message"]["content"].as_str().map(String::from).or_else(||v["message"]["content"].as_array().and_then(|p|p.iter().find_map(|p|p["text"].as_str().map(String::from)))).unwrap_or_default().chars().take(120).collect()
            }).unwrap_or_else(||id.into());
            let project_name=project.file_name().to_string_lossy().to_string();
            result.push(Session{key:format!("{project_name}/{name}"),id:id.into(),title,project:project_name,modified_at:meta.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_millis() as u64).unwrap_or(0),bytes:meta.len(),trashed});
            if result.len()>=500{break;}
        }
        if result.len()>=500{break;}
    }
    result.sort_by_key(|s|std::cmp::Reverse(s.modified_at));Ok(result)
}
fn session_path(key:&str,trashed:bool)->Result<PathBuf,String>{
    let (project,file)=key.split_once('/').ok_or("会话标识无效")?;
    if project.is_empty()||project.len()>1024||project.contains(['\\','/',':'])||project.chars().any(char::is_control)||project.ends_with('.')
        ||file.contains(['\\','/'])||file.len()>100||!file.ends_with(if trashed{".jsonl.cloudhub-trash"}else{".jsonl"}){return Err("会话标识无效".into());}
    let id=file.trim_end_matches(".cloudhub-trash").trim_end_matches(".jsonl");
    if uuid::Uuid::parse_str(id).is_err(){return Err("会话标识无效".into());}
    let root=repo::claude_home()?.join("projects").canonicalize().map_err(|_|"会话目录不可用")?;
    let path=root.join(project).join(file).canonicalize().map_err(|_|"会话不存在")?;
    if !path.starts_with(&root)||!path.is_file(){return Err("会话路径无效".into());}Ok(path)
}
pub fn session_preview(key:&str)->Result<String,String>{
    let path=session_path(key,key.ends_with(".cloudhub-trash"))?;
    let mut bytes=Vec::new();fs::File::open(path).and_then(|f|f.take(512*1024).read_to_end(&mut bytes)).map_err(|_|"读取会话失败")?;
    let mut lines=Vec::new();
    for v in String::from_utf8_lossy(&bytes).lines().filter_map(|l|serde_json::from_str::<Value>(l).ok()){
        if !matches!(v["type"].as_str(),Some("user"|"assistant")){continue;}
        let content=&v["message"]["content"];
        let text=content.as_str().map(String::from).unwrap_or_else(||content.as_array().into_iter().flatten().filter_map(|p|p["text"].as_str()).collect::<Vec<_>>().join("\n"));
        if !text.is_empty(){lines.push(format!("{}\n{}",v["type"].as_str().unwrap_or(""),text));}
    }Ok(lines.join("\n\n"))
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn traversal_and_link_like_names_are_rejected(){for name in ["../a","a/b","a\\b",".","..",""]{assert!(!valid_name(name));}assert!(valid_name("my-skill"));}
    #[test]
    fn mcp_summary_never_contains_env_or_header_values(){
        let s=server_summary("demo",&json!({"command":"node","url":"https://name:fixture-password@example.test/path?token=fixture-query","env":{"EXAMPLE_TOKEN":"fixture-secret"},"headers":{"Authorization":"fixture-header"}}),true);
        let value=serde_json::to_string(&s).unwrap();assert!(!value.contains("fixture-secret"));assert!(!value.contains("fixture-header"));assert!(s.has_secrets);
        assert!(!value.contains("fixture-password"));assert!(!value.contains("fixture-query"));
    }
    #[test]
    fn current_provider_markers_are_isolated_by_project(){
        let conn=rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(repo::SCHEMA).unwrap();
        conn.execute_batch("CREATE TABLE client_preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
          INSERT INTO claude_providers(id,name,settings_json,created_at,updated_at) VALUES('a','A','{}',0,0),('b','B','{}',0,0);").unwrap();
        set_current_provider(&conn,Some("a")).unwrap();
        conn.execute("INSERT INTO client_preferences(key,value,updated_at) VALUES(?1,'E:/fixture/project',0)",[PROJECT]).unwrap();
        assert!(current_provider(&conn).unwrap().is_none());
        set_current_provider(&conn,Some("b")).unwrap();assert_eq!(current_provider(&conn).unwrap().as_deref(),Some("b"));
        conn.execute("DELETE FROM client_preferences WHERE key=?1",[PROJECT]).unwrap();
        assert_eq!(current_provider(&conn).unwrap().as_deref(),Some("a"));
    }
}
