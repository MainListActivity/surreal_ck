//! 文件协议：每传输一条 ordered/reliable channel，头部为 8-byte BE offset。
//! 接收方需先批准文件大小/hash；写入宿主提供的writer，校验成功后由宿主安全发布。
use sha2::{Digest, Sha256};
use std::io::Write;
pub const CHUNK_SIZE: usize = 16 * 1024;
pub const MAX_FILE_SIZE: u64 = 1024 * 1024 * 1024; // 原型限制 1 GiB
#[derive(thiserror::Error, Debug)]
pub enum FileError {
    #[error("invalid size, chunk, sequence or transfer already complete")]
    InvalidFrame,
    #[error("file digest mismatch or incomplete transfer")]
    Integrity,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
pub fn frame(offset: u64, data: &[u8]) -> Result<Vec<u8>, FileError> {
    if data.is_empty() || data.len() > CHUNK_SIZE {
        return Err(FileError::InvalidFrame);
    }
    let mut output = Vec::with_capacity(8 + data.len());
    output.extend_from_slice(&offset.to_be_bytes());
    output.extend_from_slice(data);
    Ok(output)
}
pub struct Receiver<W: Write> {
    writer: W,
    size: u64,
    received: u64,
    hash: Sha256,
    expected: [u8; 32],
    poisoned: bool,
}
impl<W: Write> Receiver<W> {
    pub fn new(writer: W, size: u64, expected: [u8; 32]) -> Result<Self, FileError> {
        if size > MAX_FILE_SIZE {
            return Err(FileError::InvalidFrame);
        }
        Ok(Self {
            writer,
            size,
            received: 0,
            hash: Sha256::new(),
            expected,
            poisoned: false,
        })
    }
    pub fn receive(&mut self, frame: &[u8]) -> Result<(), FileError> {
        if self.poisoned || frame.len() <= 8 || frame.len() > CHUNK_SIZE + 8 {
            return Err(FileError::InvalidFrame);
        }
        let offset =
            u64::from_be_bytes(frame[..8].try_into().map_err(|_| FileError::InvalidFrame)?);
        let data = &frame[8..];
        if offset != self.received || data.len() as u64 > self.size - self.received {
            return Err(FileError::InvalidFrame);
        }
        self.poisoned = true;
        self.writer.write_all(data)?;
        self.poisoned = false;
        self.hash.update(data);
        self.received += data.len() as u64;
        Ok(())
    }
    pub fn finish(mut self) -> Result<W, FileError> {
        if self.poisoned
            || self.received != self.size
            || self.hash.finalize().as_slice() != self.expected
        {
            return Err(FileError::Integrity);
        }
        self.writer.flush()?;
        Ok(self.writer)
    }
}

/// 有界发送队列，避免大文件占满内存；调用方应在专用任务运行，Read 不应长期阻塞。
/// 不代表远端完成：必须由接收方 finish 成功后发送应用级 ACK。
pub async fn send<R: std::io::Read>(
    channel: &webrtc::data_channel::RTCDataChannel,
    mut reader: R,
    size: u64,
) -> Result<(), FileError> {
    use webrtc::data_channel::data_channel_state::RTCDataChannelState;
    if size > MAX_FILE_SIZE {
        return Err(FileError::InvalidFrame);
    }
    let mut offset = 0;
    let mut buffer = vec![0; CHUNK_SIZE];
    while offset < size {
        let wait = async {
            loop {
                if channel.ready_state() != RTCDataChannelState::Open {
                    return Err(FileError::InvalidFrame);
                }
                if channel.buffered_amount().await <= 256 * 1024 {
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(30), wait)
            .await
            .map_err(|_| FileError::InvalidFrame)??;
        let length = (size - offset).min(CHUNK_SIZE as u64) as usize;
        reader.read_exact(&mut buffer[..length])?;
        channel
            .send(&bytes::Bytes::from(frame(offset, &buffer[..length])?))
            .await
            .map_err(|_| FileError::InvalidFrame)?;
        offset += length as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_frames_and_hash() {
        let hash: [u8; 32] = Sha256::digest(b"abc").into();
        let mut r = Receiver::new(Vec::new(), 3, hash).unwrap();
        assert!(r.receive(&frame(1, b"abc").unwrap()).is_err());
        assert!(r.receive(&frame(0, b"abcd").unwrap()).is_err());
        r.receive(&frame(0, b"abc").unwrap()).unwrap();
        assert!(r.receive(&frame(0, b"abc").unwrap()).is_err());
        assert_eq!(r.finish().unwrap(), b"abc");
        assert!(Receiver::new(Vec::new(), MAX_FILE_SIZE + 1, hash).is_err());
        assert!(Receiver::new(Vec::new(), 3, hash)
            .unwrap()
            .finish()
            .is_err());
        let mut corrupt = Receiver::new(Vec::new(), 3, hash).unwrap();
        corrupt.receive(&frame(0, b"bad").unwrap()).unwrap();
        assert!(corrupt.finish().is_err());
        assert!(frame(0, &vec![0; CHUNK_SIZE + 1]).is_err());
        assert!(frame(0, b"").is_err());
    }
    #[test]
    fn empty_file() {
        let hash = Sha256::digest(b"").into();
        assert!(Receiver::new(Vec::new(), 0, hash)
            .unwrap()
            .finish()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn partial_write_failure_poisons_the_receiver() {
        struct FailingWriter {
            written: bool,
        }
        impl Write for FailingWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                if self.written {
                    return Err(std::io::Error::other("synthetic write failure"));
                }
                self.written = true;
                Ok(1)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut receiver = Receiver::new(
            FailingWriter { written: false },
            3,
            Sha256::digest(b"abc").into(),
        )
        .unwrap();
        let chunk = frame(0, b"abc").unwrap();
        assert!(matches!(receiver.receive(&chunk), Err(FileError::Io(_))));
        assert!(matches!(
            receiver.receive(&chunk),
            Err(FileError::InvalidFrame)
        ));
        assert!(matches!(receiver.finish(), Err(FileError::Integrity)));
    }

    #[test]
    fn flush_failure_cannot_report_finished() {
        struct FailingFlush;
        impl Write for FailingFlush {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::other("synthetic flush failure"))
            }
        }
        let mut receiver = Receiver::new(FailingFlush, 3, Sha256::digest(b"abc").into()).unwrap();
        receiver.receive(&frame(0, b"abc").unwrap()).unwrap();
        assert!(matches!(receiver.finish(), Err(FileError::Io(_))));
    }
}
