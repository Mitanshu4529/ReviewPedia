import mongoose from 'mongoose';

const ConversationSchema = new mongoose.Schema({
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }],
  // Sorted "<idA>_<idB>" of the two participants. Unique, so two concurrent
  // "start chat" requests cannot create two conversations for the same pair.
  // Sparse because conversations created before this field existed lack it.
  pairKey: {
    type: String,
    default: undefined
  },
  lastMessage: {
    type: String,
    default: ""
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

ConversationSchema.index({ pairKey: 1 }, { unique: true, sparse: true });
ConversationSchema.index({ participants: 1 });
ConversationSchema.index({ lastMessageAt: -1 });

export default mongoose.model('Conversation', ConversationSchema);
