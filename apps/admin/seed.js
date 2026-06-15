const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await bcrypt.hash(password, 10);
  const existing = await prisma.admin.findUnique({ where: { username } });
  if (!existing) {
    await prisma.admin.create({ data: { username, password: hash } });
    console.log('Admin user created:', username);
  } else {
    console.log('Admin user already exists:', username);
  }
  // Ensure counter exists
  const counter = await prisma.counter.findFirst();
  if (!counter) {
    await prisma.counter.create({ data: { value: 0 } });
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());