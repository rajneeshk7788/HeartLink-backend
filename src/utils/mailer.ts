import nodemailer from 'nodemailer';
import { config } from '../config';

let transporter: nodemailer.Transporter | null = null;

export const isMailConfigured = (): boolean => !!config.smtp.host;

const getTransporter = (): nodemailer.Transporter => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
};

export const sendPasswordResetEmail = async (to: string, resetToken: string): Promise<void> => {
  const link = `${config.clientUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;
  await getTransporter().sendMail({
    from: config.smtp.from,
    to,
    subject: 'Reset your ConnectPulse password',
    text:
      `Someone requested a password reset for your ConnectPulse account.\n\n` +
      `Reset link (valid for 1 hour): ${link}\n\n` +
      `Or paste this reset code into the app: ${resetToken}\n\n` +
      `If you did not request this, you can ignore this email.`,
  });
};
