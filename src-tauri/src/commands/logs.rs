use crate::open_db;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub(crate) struct ApiLog {
    id: i64,
    account_id: Option<i64>,
    account_name: Option<String>,
    endpoint: String,
    action: String,
    request_params: String,
    response_params: Option<String>,
    status: String,
    message: Option<String>,
    created_at: i64,
}

#[tauri::command]
pub(crate) fn list_api_logs() -> Result<Vec<ApiLog>, String> {
    let conn = open_db()?;
    let mut statement = conn
        .prepare("SELECT l.id,l.account_id,a.account_name,l.endpoint,l.action,l.request_params,l.response_params,l.status,l.message,l.created_at FROM api_logs l LEFT JOIN cloud_accounts a ON a.id=l.account_id ORDER BY l.created_at DESC LIMIT 500")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(ApiLog {
                id: row.get(0)?,
                account_id: row.get(1)?,
                account_name: row.get(2)?,
                endpoint: row.get(3)?,
                action: row.get(4)?,
                request_params: row.get(5)?,
                response_params: row.get(6)?,
                status: row.get(7)?,
                message: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

#[tauri::command]
pub(crate) fn clear_api_logs() -> Result<usize, String> {
    open_db()?
        .execute("DELETE FROM api_logs", [])
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn clear_operation_logs() -> Result<usize, String> {
    open_db()?
        .execute("DELETE FROM operation_logs", [])
        .map_err(|error| error.to_string())
}
