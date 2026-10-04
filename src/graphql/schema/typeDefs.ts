export const typeDefs = `#graphql
  enum MessageType {
    text
    image
    audio
    video
    call_log
  }

  enum MessageStatus {
    sent
    delivered
    read
  }

  enum CallType {
    audio
    video
  }

  enum CallStatus {
    initiated
    ringing
    accepted
    rejected
    missed
    completed
    busy
  }

  type User {
    id: ID!
    username: String!
    email: String!
    displayName: String!
    avatar: String
    bio: String
    gender: String
    statusMessage: String
    isOnline: Boolean!
    lastSeen: String
    createdAt: String!
    updatedAt: String!
  }

  type UnreadCount {
    userId: ID!
    count: Int!
  }

  type Conversation {
    id: ID!
    participants: [User!]!
    lastMessage: Message
    unreadCounts: [UnreadCount!]!
    createdAt: String!
    updatedAt: String!
  }

  type Message {
    id: ID!
    conversationId: ID!
    sender: User!
    content: String!
    type: MessageType!
    readBy: [ID!]!
    status: MessageStatus!
    createdAt: String!
    updatedAt: String!
  }

  type CallRecord {
    id: ID!
    caller: User!
    receiver: User!
    conversationId: ID
    callType: CallType!
    status: CallStatus!
    startedAt: String
    endedAt: String
    duration: Int!
    createdAt: String!
    updatedAt: String!
  }

  input UpdateProfileInput {
    displayName: String
    bio: String
    avatar: String
    gender: String
    statusMessage: String
  }

  input CreateCallInput {
    receiverId: ID!
    callType: CallType!
    conversationId: ID
  }

  type Query {
    GetCurrentUser: User!
    SearchUsers(query: String): [User!]!
    GetUserProfile(userId: ID!): User
    GetConversations: [Conversation!]!
    GetConversation(conversationId: ID!): Conversation
    GetMessages(conversationId: ID!, limit: Int, offset: Int): [Message!]!
    GetCallHistory: [CallRecord!]!
  }

  type Mutation {
    UpdateProfile(input: UpdateProfileInput!): User!
    CreateConversation(participantId: ID!): Conversation!
    SendMessage(conversationId: ID!, content: String!, type: MessageType): Message!
    MarkMessageAsRead(messageId: ID!): Message!
    DeleteMessage(messageId: ID!): Boolean!
    CreateCallRecord(input: CreateCallInput!): CallRecord!
    UpdateCallStatus(callId: ID!, status: CallStatus!, duration: Int): CallRecord!
  }
`;
