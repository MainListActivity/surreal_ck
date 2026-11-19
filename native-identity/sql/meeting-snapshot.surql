RETURN {
  meetings: (SELECT * FROM meeting WHERE status = 'active' ORDER BY created_at, id LIMIT 513),
  participants: (SELECT * FROM meeting_participant LIMIT 4097),
  signals: (SELECT *, time::nano(created_at) AS created_ns, time::nano(expires_at) AS expires_ns
    FROM meeting_signal WHERE to = $auth.id AND expires_at > time::now() ORDER BY created_at, id LIMIT 8193),
  server_ns: time::nano(time::now())
};
