//! 仅测试帧边界和内存生命周期；这些字节不作为任何真实设备或 UI 的替代视频。
use bytes::Bytes;
use std::sync::Arc;
use surreal_ck_native_video_view::{Error, FrameHub, FrameUpdate, RgbaFrame, MAX_STREAMS};

fn frame(value: u8) -> RgbaFrame {
    RgbaFrame::packed(2, 2, Bytes::from(vec![value; 16])).unwrap()
}

fn value(receiver: &mut surreal_ck_native_video_view::FrameReceiver) -> u8 {
    match receiver.poll() {
        FrameUpdate::Frame { frame, .. } => frame.pixels()[0],
        other => panic!("expected frame: {other:?}"),
    }
}

#[test]
fn rejects_zero_and_excessive_dimensions() {
    for (w, h) in [(0, 1), (1, 0), (4097, 1), (1, 4097), (u32::MAX, 1)] {
        assert_eq!(
            RgbaFrame::packed(w, h, Bytes::new()).unwrap_err(),
            Error::Dimensions
        );
    }
}

#[test]
fn exact_rgba_length_and_stride_are_required() {
    for size in [0, 15, 17, 20] {
        assert_eq!(
            RgbaFrame::packed(2, 2, Bytes::from(vec![0; size])).unwrap_err(),
            Error::BufferLayout
        );
    }
    for stride in [0, 4, 7, 9, usize::MAX] {
        assert!(RgbaFrame::new(2, 2, stride, Bytes::new()).is_err());
    }
}

#[test]
fn supports_valid_row_padding_without_repacking() {
    let pixels = Bytes::from(vec![3; 24]);
    let pointer = pixels.as_ptr();
    let frame = RgbaFrame::new(2, 2, 12, pixels).unwrap();
    assert_eq!((frame.width(), frame.height(), frame.stride()), (2, 2, 12));
    assert_eq!(frame.pixels().as_ptr(), pointer);
}

#[test]
fn rejects_oversized_frame_buffers() {
    let pixels = Bytes::from(vec![0; 4096 * 4096 * 4]);
    assert_eq!(
        RgbaFrame::packed(4096, 4096, pixels).unwrap_err(),
        Error::FrameTooLarge
    );
}

#[test]
fn empty_stream_does_not_invent_a_frame() {
    let hub = FrameHub::default();
    let publisher = hub.open().unwrap();
    let mut receiver = hub.subscribe(publisher.id()).unwrap();
    assert!(matches!(receiver.poll(), FrameUpdate::Unchanged));
}

#[test]
fn only_latest_frame_survives_when_ui_is_slow() {
    let hub = FrameHub::default();
    let publisher = hub.open().unwrap();
    let mut receiver = hub.subscribe(publisher.id()).unwrap();
    for i in 0..=255 {
        publisher.present(frame(i)).unwrap();
    }
    match receiver.poll() {
        FrameUpdate::Frame { frame, sequence } => {
            assert_eq!(frame.pixels()[0], 255);
            assert_eq!(sequence, 256);
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(receiver.poll(), FrameUpdate::Unchanged));
}

#[test]
fn subscribing_after_publish_obtains_current_frame() {
    let hub = FrameHub::default();
    let publisher = hub.open().unwrap();
    publisher.present(frame(3)).unwrap();
    assert_eq!(value(&mut hub.subscribe(publisher.id()).unwrap()), 3);
}

#[test]
fn multiple_views_consume_independently() {
    let hub = FrameHub::default();
    let publisher = hub.open().unwrap();
    let mut a = hub.subscribe(publisher.id()).unwrap();
    let mut b = hub.subscribe(publisher.id()).unwrap();
    publisher.present(frame(8)).unwrap();
    assert_eq!(value(&mut a), 8);
    assert_eq!(value(&mut b), 8);
    assert!(matches!(a.poll(), FrameUpdate::Unchanged));
}

#[test]
fn replacing_frame_releases_old_buffer_when_renderer_releases_it() {
    let hub = FrameHub::default();
    let publisher = hub.open().unwrap();
    let mut receiver = hub.subscribe(publisher.id()).unwrap();
    publisher.present(frame(1)).unwrap();
    let old = match receiver.poll() {
        FrameUpdate::Frame { frame, .. } => frame,
        _ => panic!(),
    };
    let weak = Arc::downgrade(&old);
    publisher.present(frame(2)).unwrap();
    assert!(weak.upgrade().is_some());
    drop(old);
    assert!(weak.upgrade().is_none());
    assert_eq!(value(&mut receiver), 2);
}

#[test]
fn close_clears_frame_and_rejects_future_publish() {
    let hub = FrameHub::default();
    let publisher = hub.open().unwrap();
    let mut receiver = hub.subscribe(publisher.id()).unwrap();
    publisher.present(frame(1)).unwrap();
    let weak = match receiver.poll() {
        FrameUpdate::Frame { frame, .. } => Arc::downgrade(&frame),
        _ => panic!(),
    };
    publisher.close();
    publisher.close();
    assert!(weak.upgrade().is_none());
    assert!(matches!(receiver.poll(), FrameUpdate::Closed));
    assert_eq!(publisher.present(frame(2)).unwrap_err(), Error::Closed);
    assert!(matches!(
        hub.subscribe(publisher.id()),
        Err(Error::UnknownStream)
    ));
}

#[test]
fn only_last_publisher_drop_closes_stream() {
    let hub = FrameHub::default();
    let publisher = hub.open().unwrap();
    let clone = publisher.clone();
    let mut receiver = hub.subscribe(publisher.id()).unwrap();
    drop(publisher);
    clone.present(frame(9)).unwrap();
    assert_eq!(value(&mut receiver), 9);
    drop(clone);
    assert!(matches!(receiver.poll(), FrameUpdate::Closed));
}

#[test]
fn dropping_view_does_not_close_producer() {
    let hub = FrameHub::default();
    let publisher = hub.open().unwrap();
    drop(hub.subscribe(publisher.id()).unwrap());
    publisher.present(frame(7)).unwrap();
    assert_eq!(value(&mut hub.subscribe(publisher.id()).unwrap()), 7);
}

#[test]
fn stream_bound_reclaims_closed_slots_and_never_reuses_id() {
    let hub = FrameHub::default();
    let streams: Vec<_> = (0..MAX_STREAMS).map(|_| hub.open().unwrap()).collect();
    assert!(matches!(hub.open(), Err(Error::TooManyStreams)));
    let previous = streams[0].id().to_owned();
    let mut receiver = hub.subscribe(&previous).unwrap();
    streams[0].close();
    let replacement = hub.open().unwrap();
    assert_ne!(previous, replacement.id());
    assert!(matches!(receiver.poll(), FrameUpdate::Closed));
    assert!(matches!(
        hub.subscribe(&previous),
        Err(Error::UnknownStream)
    ));
}

#[test]
fn repeated_sessions_do_not_exhaust_weak_registry() {
    let hub = FrameHub::default();
    for _ in 0..1000 {
        drop(hub.open().unwrap());
    }
    assert!(hub.open().is_ok());
}

#[test]
fn unrelated_or_missing_stream_ids_are_rejected() {
    let hub = FrameHub::default();
    assert!(matches!(
        hub.subscribe("video-1"),
        Err(Error::UnknownStream)
    ));
    assert!(matches!(hub.subscribe(""), Err(Error::UnknownStream)));
}

#[test]
fn producer_and_ui_can_run_on_different_threads_without_reordering() {
    let hub = FrameHub::default();
    let publisher = hub.open().unwrap();
    let mut receiver = hub.subscribe(publisher.id()).unwrap();
    let worker = publisher.clone();
    let thread = std::thread::spawn(move || {
        for index in 0..10_000 {
            worker.present(frame((index % 256) as u8)).unwrap();
        }
    });
    let mut previous = 0;
    while !thread.is_finished() {
        if let FrameUpdate::Frame { sequence, .. } = receiver.poll() {
            assert!(sequence > previous);
            previous = sequence;
        }
        std::thread::yield_now();
    }
    thread.join().unwrap();
    if let FrameUpdate::Frame { sequence, frame } = receiver.poll() {
        assert_eq!(sequence, 10_000);
        assert_eq!(frame.pixels()[0], (9_999 % 256) as u8);
    } else {
        assert_eq!(previous, 10_000);
    }
    publisher.close();
    assert!(matches!(receiver.poll(), FrameUpdate::Closed));
}

#[test]
fn transport_side_types_are_send_sync() {
    fn both<T: Send + Sync>() {}
    both::<RgbaFrame>();
    both::<surreal_ck_native_video_view::FramePublisher>();
    both::<FrameHub>();
    both::<surreal_ck_native_video_view::FrameReceiver>();
}
