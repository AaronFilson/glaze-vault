//! Messages over a stream, in the frames of proto.rs.

use crate::proto::{Frames, frame};
use crate::{Error, Result};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub struct Conn<S> {
    stream: S,
    frames: Frames,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Conn<S> {
    pub fn new(stream: S) -> Conn<S> {
        Conn {
            stream,
            frames: Frames::default(),
        }
    }

    pub fn stream(&self) -> &S {
        &self.stream
    }

    pub async fn send<T: Serialize>(&mut self, message: &T) -> Result<()> {
        self.stream.write_all(&frame(message)?).await?;
        self.stream.flush().await?;
        Ok(())
    }

    /// The next message; an error if the other side closed first.
    pub async fn recv<T: DeserializeOwned>(&mut self) -> Result<T> {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            if let Some(message) = self.frames.read()? {
                return Ok(message);
            }
            let read = self.stream.read(&mut buffer).await?;
            if read == 0 {
                return Err(Error::Closed);
            }
            self.frames.push(&buffer[..read]);
        }
    }

    pub async fn close(mut self) {
        let _ = self.stream.shutdown().await;
    }
}
