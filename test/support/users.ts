import { hashPassword } from "../../src/auth/password";
import { createUsersStore, type Role, type UserStatus } from "../../src/auth/users-store";

// Stands in for admin approval until the enable endpoint exists (Stage 3).
export async function createUserWithStatus(
  tableName: string,
  username: string,
  password: string,
  status: UserStatus,
  role: Role = "customer",
) {
  return createUsersStore(tableName).create({
    username,
    passwordHash: await hashPassword(password),
    role,
    status,
    now: new Date(),
  });
}
