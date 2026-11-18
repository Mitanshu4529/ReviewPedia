// Changes an account's role (user, admin or b2b).
//
// The two emailing AI agents can only be run by admin accounts, and there is no
// screen for granting that role, so it is set from the command line by whoever
// has access to the database:
//
//   node scripts/setRole.js someone@example.com admin
//   node scripts/setRole.js someone@example.com user      (to take it away)
//
// Uses MONGODB_URI from backend/.env, like the server does.
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

import User from '../models/User.js';

const ROLES = ['user', 'admin', 'b2b'];
const [email, role] = process.argv.slice(2);

if (!email || !ROLES.includes(role)) {
  console.error(`Usage: node scripts/setRole.js <email> <${ROLES.join('|')}>`);
  process.exit(1);
}

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/reviewpedia';

try {
  await mongoose.connect(uri);
  const user = await User.findOneAndUpdate(
    { email: email.trim().toLowerCase() },
    { role },
    { new: true }
  ).select('username email role');

  if (!user) {
    console.error(`No account with the email ${email}.`);
    process.exitCode = 1;
  } else {
    console.log(`${user.username} (${user.email}) now has the role "${user.role}".`);
  }
} catch (err) {
  console.error('Could not change the role:', err.message);
  process.exitCode = 1;
} finally {
  await mongoose.connection.close();
}
