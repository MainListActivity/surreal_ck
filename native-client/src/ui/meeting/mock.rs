//! 仅供预览与测试；不模拟真实设备采集或网络连通证据。
use super::*;

#[derive(Clone, Debug)]
pub struct MockMeeting {
    pub room: Option<RoomSnapshot>,
    pub local: Contact,
    next_id: u64,
}
impl Default for MockMeeting {
    fn default() -> Self {
        Self {
            room: None,
            local: Contact {
                member_id: "local".into(),
                name: "我".into(),
            },
            next_id: 0,
        }
    }
}
impl MockMeeting {
    fn member(&mut self, contact: Contact, local: bool, host: bool) -> MemberView {
        self.next_id += 1;
        MemberView {
            member_id: contact.member_id,
            display_name: contact.name,
            join_id: format!("join-{}", self.next_id),
            is_host: host,
            is_local: local,
            mic: DeviceState::Off,
            camera: DeviceState::Off,
            sharing: false,
            edge: if local {
                EdgeStatus::Unknown
            } else {
                EdgeStatus::Connecting
            },
        }
    }
    pub fn add_member(&mut self, contact: Contact) -> Vec<MeetingUpdate> {
        let Some(room) = &self.room else {
            return vec![MeetingUpdate::Error(MeetingError::NotFoundOrNotInvited)];
        };
        if room.members.len() >= 4 {
            return vec![MeetingUpdate::Error(MeetingError::Full)];
        }
        if room
            .members
            .iter()
            .any(|m| m.member_id == contact.member_id)
        {
            return vec![];
        }
        let member = self.member(contact, false, false);
        let room = self.room.as_mut().unwrap();
        room.members.push(member);
        room.version += 1;
        let connecting = room.clone();
        room.members.last_mut().unwrap().edge = EdgeStatus::Direct;
        room.version += 1;
        vec![
            MeetingUpdate::Snapshot(connecting),
            MeetingUpdate::Snapshot(room.clone()),
        ]
    }
    pub fn handle(&mut self, command: MeetingCommand) -> Vec<MeetingUpdate> {
        match command {
            MeetingCommand::Create | MeetingCommand::CreateFor { .. } => {
                let local = self.member(self.local.clone(), true, true);
                self.room = Some(RoomSnapshot {
                    room_id: format!("mock-{}", self.next_id),
                    room_code: format!("MEET{:04}", self.next_id),
                    version: 1,
                    state: RoomState::Active,
                    host: local.member_id.clone(),
                    local_join_id: Some(local.join_id.clone()),
                    members: vec![local],
                });
                vec![MeetingUpdate::Snapshot(self.room.clone().unwrap())]
            }
            MeetingCommand::Join { room_code } => {
                let Some(room) = &self.room else {
                    return vec![MeetingUpdate::Error(MeetingError::NotFoundOrNotInvited)];
                };
                if room.room_code != room_code {
                    return vec![MeetingUpdate::Error(MeetingError::NotFoundOrNotInvited)];
                }
                if room.state != RoomState::Active {
                    return vec![MeetingUpdate::Error(MeetingError::Expired)];
                }
                if room.members.iter().any(|m| m.is_local) {
                    return vec![MeetingUpdate::Snapshot(room.clone())];
                }
                if room.members.len() >= 4 {
                    return vec![MeetingUpdate::Error(MeetingError::Full)];
                }
                let is_host = room.host == self.local.member_id;
                let local = self.member(self.local.clone(), true, is_host);
                let room = self.room.as_mut().unwrap();
                room.local_join_id = Some(local.join_id.clone());
                room.members.push(local);
                room.version += 1;
                for m in &mut room.members {
                    if !m.is_local {
                        m.edge = EdgeStatus::Connecting;
                    }
                }
                let connecting = room.clone();
                for m in &mut room.members {
                    if !m.is_local {
                        m.edge = EdgeStatus::Direct;
                    }
                }
                room.version += 1;
                vec![
                    MeetingUpdate::Snapshot(connecting),
                    MeetingUpdate::Snapshot(room.clone()),
                ]
            }
            MeetingCommand::SetDevice { source, on } => self.device(source, on),
            MeetingCommand::StartShare => self.device(Source::Screen, true),
            MeetingCommand::StopShare => self.device(Source::Screen, false),
            MeetingCommand::Leave => {
                if let Some(room) = &mut self.room {
                    room.members.retain(|m| !m.is_local);
                    room.local_join_id = None;
                    room.version += 1;
                }
                let mut updates = vec![MeetingUpdate::Left];
                updates.extend(Source::ALL.map(|source| MeetingUpdate::Device {
                    source,
                    state: DeviceState::Off,
                }));
                updates
            }
            MeetingCommand::End => {
                if !self.room.as_ref().is_some_and(|r| {
                    r.members
                        .iter()
                        .any(|m| m.is_local && m.member_id == r.host)
                }) {
                    return vec![];
                }
                self.room.as_mut().unwrap().state = RoomState::Ended;
                let mut updates = vec![MeetingUpdate::Ended { by_host: true }];
                updates.extend(Source::ALL.map(|source| MeetingUpdate::Device {
                    source,
                    state: DeviceState::Off,
                }));
                updates
            }
            MeetingCommand::RetryEdge { member_id, join_id } => {
                let Some(room) = &mut self.room else {
                    return vec![];
                };
                let Some(member) = room.members.iter_mut().find(|m| {
                    m.member_id == member_id
                        && m.join_id == join_id
                        && !m.is_local
                        && m.edge.can_retry()
                }) else {
                    return vec![];
                };
                member.edge = EdgeStatus::Connecting;
                room.version += 1;
                vec![MeetingUpdate::Snapshot(room.clone())]
            }
            MeetingCommand::Invite {
                room_id,
                member_ids,
            } => {
                if self.room.as_ref().is_some_and(|r| r.room_id == room_id) {
                    member_ids
                        .into_iter()
                        .flat_map(|id| {
                            self.add_member(Contact {
                                name: id.clone(),
                                member_id: id,
                            })
                        })
                        .collect()
                } else {
                    vec![]
                }
            }
            MeetingCommand::DismissError => vec![],
        }
    }
    fn device(&mut self, source: Source, on: bool) -> Vec<MeetingUpdate> {
        let state = if on {
            DeviceState::On
        } else {
            DeviceState::Off
        };
        let mut updates = vec![MeetingUpdate::Device { source, state }];
        if let Some(room) = &mut self.room {
            if let Some(local) = room.members.iter_mut().find(|m| m.is_local) {
                match source {
                    Source::Mic => local.mic = state,
                    Source::Camera => local.camera = state,
                    Source::Screen => local.sharing = on,
                }
            }
            room.version += 1;
            updates.push(MeetingUpdate::Snapshot(room.clone()));
        }
        updates
    }
}
