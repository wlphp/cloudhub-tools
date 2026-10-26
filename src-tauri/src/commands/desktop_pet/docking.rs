#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge { Left, Right, Top, Bottom }

pub fn handle_size(edge: Edge) -> (f64,f64) {
    match edge { Edge::Top | Edge::Bottom => (24.,64.), Edge::Left | Edge::Right => (64.,24.) }
}

/// Clamp the visible avatar, allowing the transparent window margins off screen.
pub fn avatar_position(p: (i32,i32), window: (u32,u32), pet_size: u32, scale: f64, area: (i32,i32,u32,u32)) -> (i32,i32) {
    let (avatar, size) = avatar_bounds(p, window.1, pet_size, scale);
    let left = p.0 - avatar.0 + area.0;
    let top = p.1 - avatar.1 + area.1;
    (p.0.clamp(left, (left + area.2 as i32 - size.0 as i32).max(left)),
     p.1.clamp(top, (top + area.3 as i32 - size.1 as i32).max(top)))
}

pub fn avatar_bounds(p: (i32,i32), window_height: u32, pet_size: u32, scale: f64) -> ((i32,i32),(u32,u32)) {
    let size = (pet_size as f64 * scale).round() as u32;
    ((p.0+(40.*scale).round() as i32,p.1+window_height as i32-size as i32-(12.*scale).round() as i32),(size,size))
}

/// Whether the primary mouse button is currently pressed, honoring the
/// swapped-button setting. Non-Windows targets have no global query and
/// always report released.
pub fn primary_pressed() -> bool {
    #[cfg(target_os = "windows")]
    {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn GetAsyncKeyState(key: i32) -> i16;
            fn GetSystemMetrics(index: i32) -> i32;
        }
        let primary = if unsafe { GetSystemMetrics(23) } != 0 { 0x02 } else { 0x01 };
        return unsafe { GetAsyncKeyState(primary) } < 0;
    }
    #[cfg(not(target_os = "windows"))]
    false
}

/// Windows starts caption dragging asynchronously. Its IPC acknowledgement is not a drop event.
pub async fn wait_for_drop() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        wait_until_released(primary_pressed).await?;
    }
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
async fn wait_until_released(mut pressed: impl FnMut() -> bool) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    while pressed() {
        if tokio::time::Instant::now() >= deadline { return Err("拖动尚未结束，请松开鼠标后重试".into()); }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    Ok(())
}

/// Physical coordinates, including negative monitor origins and per-monitor scale.
pub fn edge_at(p: (i32, i32), size: (u32, u32), area: (i32, i32, u32, u32), threshold: i32) -> Option<Edge> {
    let (x,y,w,h) = area;
    [
        (p.0-x, Edge::Left), (x+w as i32-p.0-size.0 as i32, Edge::Right),
        (p.1-y, Edge::Top), (y+h as i32-p.1-size.1 as i32, Edge::Bottom),
    ].into_iter().filter(|(distance,_)| *distance <= threshold).min_by_key(|(distance,_)| distance.abs()).map(|(_,edge)|edge)
}

pub fn head_position(edge: Edge, p: (i32,i32), size: (u32,u32), area: (i32,i32,u32,u32)) -> (i32,i32) {
    let (x,y,w,h) = area;
    let right = (x+w as i32-size.0 as i32).max(x);
    let bottom = (y+h as i32-size.1 as i32).max(y);
    let mut p = (p.0.clamp(x,right),p.1.clamp(y,bottom));
    match edge { Edge::Left=>p.0=x,Edge::Right=>p.0=right,Edge::Top=>p.1=y,Edge::Bottom=>p.1=bottom }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rope_windows_are_narrow_and_face_inward_on_every_edge() {
        for edge in [Edge::Top,Edge::Bottom] { assert_eq!(handle_size(edge),(24.,64.)); }
        for edge in [Edge::Left,Edge::Right] { assert_eq!(handle_size(edge),(64.,24.)); }
    }
    #[test]
    fn transparent_margins_do_not_block_top_and_left_or_hide_the_avatar() {
        assert_eq!(avatar_position((-400,-400),(200,160),120,1.,(0,0,1920,1040)),(-40,-28));
        assert_eq!(avatar_position((4000,4000),(200,160),120,1.,(0,0,1920,1040)),(1760,892));
        assert_eq!(avatar_position((-4000,-400),(300,240),120,1.5,(-1920,0,1920,1560)),(-1980,-42));
    }
    #[tokio::test]
    async fn drag_acknowledgement_does_not_finish_until_the_button_is_released() {
        let mut samples = [true,true,false].into_iter();
        let mut checks = 0;
        wait_until_released(|| { checks += 1; samples.next().unwrap_or(false) }).await.unwrap();
        assert_eq!(checks,3);
        let mut checks = 0;
        wait_until_released(|| { checks += 1; false }).await.unwrap();
        assert_eq!(checks,1);
    }
    #[test]
    fn expanded_windows_and_high_dpi_use_the_visible_pet_bounds() {
        assert_eq!(avatar_bounds((-40,100),480,120,1.),((0,448),(120,120)));
        assert_eq!(avatar_bounds((-60,150),720,120,1.5),((0,672),(180,180)));
        assert_eq!(edge_at((0,448),(120,120),(0,0,1920,1040),16),Some(Edge::Left));
    }
    #[test]
    fn four_edges_negative_origins_and_corners_stay_in_the_selected_monitor() {
        let area=(-1920,0,1920,1040); let size=(240,200);
        for (p,edge) in [((-1930,400),Edge::Left),((-240,400),Edge::Right),((-800,-5),Edge::Top),((-800,840),Edge::Bottom)] {
            assert_eq!(edge_at(p,size,area,16),Some(edge));
            let (x,y)=head_position(edge,p,(104,72),area);
            assert!(x>=-1920 && x+104<=0 && y>=0 && y+72<=1040);
        }
        assert_eq!(edge_at((-800,400),size,area,16),None);
        assert_eq!(edge_at((-1899,400),size,area,16),None);
        assert_eq!(edge_at((-1899,400),size,area,24),Some(Edge::Left));
        assert_eq!(head_position(Edge::Bottom,(999,999),(100,70),(0,0,80,60)),(0,0));
    }
}
