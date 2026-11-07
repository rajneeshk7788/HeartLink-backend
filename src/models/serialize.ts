/**
 * Shared toJSON/toObject options so documents sent over Socket.IO always carry
 * a string `id` (not just `_id`) and never leak secrets.
 */
const SENSITIVE_FIELDS = ['password', 'refreshTokens', 'resetPasswordToken', 'resetPasswordExpires', '__v'];

export const jsonOptions = {
  virtuals: true,
  versionKey: false,
  transform: (_doc: any, ret: any) => {
    if (ret._id != null) {
      ret.id = ret._id.toString();
    }
    for (const field of SENSITIVE_FIELDS) {
      delete ret[field];
    }
    return ret;
  },
};

/** Public (non-sensitive) user fields used when populating references. */
export const USER_PUBLIC_FIELDS =
  'username displayName avatar bio gender statusMessage isOnline lastSeen createdAt updatedAt';
