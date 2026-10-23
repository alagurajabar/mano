import bcrypt from "bcryptjs";
const BCRYPT_COST = 12;
export async function hashPassword(password) {
    return bcrypt.hash(password, BCRYPT_COST);
}
export async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}
