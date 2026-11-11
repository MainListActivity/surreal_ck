//! 两个实验原生后端共享的有限尺寸布局/像素操作；不改变帧边界或 Linux 后端。

/// 返回居中 contain 矩形 (left, top, width, height)，拒绝无效宿主布局。
pub(crate) fn contain(size: (f32, f32), image: (u32, u32)) -> Option<(f32, f32, f32, f32)> {
    if !size.0.is_finite()
        || !size.1.is_finite()
        || size.0 <= 0.0
        || size.1 <= 0.0
        || image.0 == 0
        || image.1 == 0
    {
        return None;
    }
    let scale = (size.0 / image.0 as f32).min(size.1 / image.1 as f32);
    let width = image.0 as f32 * scale;
    let height = image.1 as f32 * scale;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some((
        (size.0 - width) * 0.5,
        (size.1 - height) * 0.5,
        width,
        height,
    ))
}

/// 远端分辨率不能无限增大组件的默认固有布局；宿主仍可指定明确宽高。
pub(crate) fn intrinsic(image: (u32, u32)) -> (f32, f32) {
    contain((320.0, 180.0), image)
        .map(|(_, _, w, h)| (w, h))
        .unwrap_or((320.0, 180.0))
}

/// Direct2D 使用预乘 BGRA。逐行跳过输入 padding，复用有界输出缓冲。
#[cfg(any(test, all(target_os = "windows", feature = "windows-d2d")))]
pub(crate) fn premultiplied_bgra(frame: &crate::RgbaFrame, output: &mut Vec<u8>) {
    let row = frame.width() as usize * 4;
    output.resize(row * frame.height() as usize, 0);
    let multiply =
        |channel: u8, alpha: u8| ((u16::from(channel) * u16::from(alpha) + 127) / 255) as u8;
    for (source, target) in frame
        .pixels()
        .chunks_exact(frame.stride())
        .zip(output.chunks_exact_mut(row))
    {
        for (rgba, bgra) in source[..row]
            .as_chunks::<4>()
            .0
            .iter()
            .zip(target.as_chunks_mut::<4>().0.iter_mut())
        {
            bgra[0] = multiply(rgba[2], rgba[3]);
            bgra[1] = multiply(rgba[1], rgba[3]);
            bgra[2] = multiply(rgba[0], rgba[3]);
            bgra[3] = rgba[3];
        }
    }
}

#[cfg(any(
    all(target_os = "macos", feature = "macos-appkit"),
    all(target_os = "windows", feature = "windows-d2d")
))]
pub(crate) enum Event {
    Ready((u32, u32)),
    Closed,
    Error(String),
}
#[cfg(any(
    all(target_os = "macos", feature = "macos-appkit"),
    all(target_os = "windows", feature = "windows-d2d")
))]
pub(crate) type Notify = std::rc::Rc<dyn Fn(Event)>;

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    #[test]
    fn contain_preserves_aspect_and_centers() {
        assert_eq!(
            contain((400.0, 400.0), (640, 360)),
            Some((0.0, 87.5, 400.0, 225.0))
        );
        assert_eq!(
            contain((640.0, 360.0), (360, 640)),
            Some((218.75, 0.0, 202.5, 360.0))
        );
    }
    #[test]
    fn invalid_layout_is_not_drawn() {
        for size in [
            (0.0, 1.0),
            (-1.0, 2.0),
            (f32::NAN, 2.0),
            (2.0, f32::INFINITY),
        ] {
            assert!(contain(size, (640, 360)).is_none());
        }
        assert!(contain((320.0, 180.0), (0, 1)).is_none());
    }
    #[test]
    fn intrinsic_size_is_bounded_even_for_large_frames() {
        assert_eq!(intrinsic((3840, 2160)), (320.0, 180.0));
        assert_eq!(intrinsic((4096, 4096)), (180.0, 180.0));
    }
    #[test]
    fn rgba_is_reordered_and_premultiplied() {
        let frame = crate::RgbaFrame::packed(
            3,
            1,
            Bytes::from_static(&[255, 64, 0, 255, 255, 64, 32, 128, 255, 64, 32, 0]),
        )
        .unwrap();
        let mut output = Vec::new();
        premultiplied_bgra(&frame, &mut output);
        assert_eq!(output, [0, 64, 255, 255, 16, 32, 128, 128, 0, 0, 0, 0]);
    }
    #[test]
    fn conversion_skips_row_padding_and_reuses_allocation() {
        let frame = crate::RgbaFrame::new(
            1,
            2,
            8,
            Bytes::from_static(&[1, 2, 3, 255, 99, 99, 99, 99, 4, 5, 6, 255, 77, 77, 77, 77]),
        )
        .unwrap();
        let mut output = Vec::with_capacity(8);
        let before = output.as_ptr();
        premultiplied_bgra(&frame, &mut output);
        assert_eq!(output, [3, 2, 1, 255, 6, 5, 4, 255]);
        assert_eq!(before, output.as_ptr());
    }
}
