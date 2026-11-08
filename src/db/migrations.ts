/**
 * Versioned schema migrations. Each entry runs once, in order, inside a transaction;
 * applied versions are recorded in the schema_migrations table.
 *
 * Never edit a migration that has already run anywhere — add a new one instead.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE users (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        username                text NOT NULL UNIQUE CHECK (char_length(username) BETWEEN 3 AND 30),
        email                   text NOT NULL UNIQUE,
        password_hash           text NOT NULL,
        display_name            text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 50),
        avatar                  text NOT NULL DEFAULT '',
        bio                     text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 500),
        gender                  text NOT NULL DEFAULT 'prefer-not-to-say',
        status_message          text NOT NULL DEFAULT 'Hey there! I am using ConnectPulse.'
                                  CHECK (char_length(status_message) <= 140),
        is_online               boolean NOT NULL DEFAULT false,
        last_seen               timestamptz NOT NULL DEFAULT now(),
        reset_password_token    text,
        reset_password_expires  timestamptz,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX users_last_seen_idx ON users (last_seen DESC);
      CREATE INDEX users_display_name_idx ON users (display_name);
      CREATE INDEX users_reset_token_idx ON users (reset_password_token) WHERE reset_password_token IS NOT NULL;

      -- Hashed refresh tokens (one row per signed-in device)
      CREATE TABLE refresh_tokens (
        token_hash  text PRIMARY KEY,
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id, created_at);

      CREATE TABLE conversations (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- "smallerUserId:largerUserId" for 1-on-1 chats: guarantees one chat per pair
        direct_key       text UNIQUE,
        last_message_id  uuid,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX conversations_updated_idx ON conversations (updated_at DESC);

      CREATE TABLE conversation_participants (
        conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        unread_count     integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
        joined_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (conversation_id, user_id)
      );
      CREATE INDEX conversation_participants_user_idx ON conversation_participants (user_id);

      CREATE TABLE messages (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        sender_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        content          text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 5000),
        type             text NOT NULL DEFAULT 'text'
                           CHECK (type IN ('text', 'image', 'audio', 'video', 'call_log')),
        status           text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at DESC);
      CREATE INDEX messages_sender_idx ON messages (sender_id);

      -- Who has read which message (replaces Mongo's readBy array)
      CREATE TABLE message_reads (
        message_id  uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        read_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (message_id, user_id)
      );
      CREATE INDEX message_reads_user_idx ON message_reads (user_id);

      ALTER TABLE conversations
        ADD CONSTRAINT conversations_last_message_fk
        FOREIGN KEY (last_message_id) REFERENCES messages (id) ON DELETE SET NULL;

      CREATE TABLE call_records (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        caller_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        receiver_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        conversation_id  uuid REFERENCES conversations (id) ON DELETE SET NULL,
        call_type        text NOT NULL CHECK (call_type IN ('audio', 'video')),
        status           text NOT NULL DEFAULT 'initiated'
                           CHECK (status IN ('initiated', 'ringing', 'accepted', 'rejected', 'missed', 'completed', 'busy')),
        started_at       timestamptz,
        ended_at         timestamptz,
        duration         integer NOT NULL DEFAULT 0 CHECK (duration >= 0),
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX call_records_caller_idx ON call_records (caller_id, created_at DESC);
      CREATE INDEX call_records_receiver_idx ON call_records (receiver_id, created_at DESC);
    `,
  },
];
