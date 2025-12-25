const { PrismaClient } = require("@prisma/client");

const prismaGlobal = global;

const prisma = prismaGlobal.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") {
    prismaGlobal.prisma = prisma;
}

module.exports = prisma;
