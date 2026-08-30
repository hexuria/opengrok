export const CLIENT_PERSISTENCE_CHANNELS = {
  read: "sand:client-persistence-read",
  write: "sand:client-persistence-write",
  remove: "sand:client-persistence-remove",
  listKeys: "sand:client-persistence-list-keys",
  migrate: "sand:client-persistence-migrate",
} as const;
