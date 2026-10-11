CREATE TABLE IF NOT EXISTS players (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  state JSON NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY players_username (username)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS player_requests (
  player_id BIGINT UNSIGNED NOT NULL,
  request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation VARCHAR(32) NOT NULL,
  response JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (player_id, request_id),
  CONSTRAINT requests_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS world_drops (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  map_id INT UNSIGNED NOT NULL,
  x INT NOT NULL,
  y INT NOT NULL,
  kind ENUM('item', 'weapon', 'armor', 'bag') NOT NULL DEFAULT 'item',
  item_id INT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  metadata JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY drops_map (map_id),
  CONSTRAINT drops_quantity_positive CHECK (quantity > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS player_profiles (
  player_id BIGINT UNSIGNED NOT NULL,
  profile JSON NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (player_id),
  CONSTRAINT profiles_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rounds (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  definition_id VARCHAR(96) NOT NULL,
  status ENUM('waiting', 'active', 'finished', 'aborted') NOT NULL DEFAULT 'waiting',
  metadata JSON NOT NULL,
  result JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  ended_at TIMESTAMP(3) NULL,
  PRIMARY KEY (id),
  KEY rounds_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS round_participants (
  round_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  state JSON NOT NULL,
  status ENUM('active', 'left', 'finished', 'aborted') NOT NULL DEFAULT 'active',
  result JSON NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  joined_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  left_at TIMESTAMP(3) NULL,
  PRIMARY KEY (round_id, player_id),
  KEY participation_player_status (player_id, status),
  CONSTRAINT participant_round FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE,
  CONSTRAINT participant_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS round_requests (
  round_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation VARCHAR(32) NOT NULL,
  response JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (round_id, player_id, request_id),
  CONSTRAINT request_participant FOREIGN KEY (round_id, player_id) REFERENCES round_participants(round_id, player_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS round_claims (
  round_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claim_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claim_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  result JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (round_id, claim_kind, claim_id),
  CONSTRAINT claim_participant FOREIGN KEY (round_id, player_id) REFERENCES round_participants(round_id, player_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS round_drops (
  round_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  map_id INT UNSIGNED NOT NULL,
  x INT NOT NULL,
  y INT NOT NULL,
  kind ENUM('item', 'weapon', 'armor', 'bag') NOT NULL DEFAULT 'item',
  item_id INT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  metadata JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (round_id, id),
  KEY round_drops_map (round_id, map_id),
  CONSTRAINT drop_round FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE,
  CONSTRAINT round_drops_quantity_positive CHECK (quantity > 0)
) ENGINE=InnoDB;
