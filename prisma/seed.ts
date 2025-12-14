const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const income = await prisma.transactionType.upsert({
    where: { name: "income" },
    update: {},
    create: { name: "income" },
  });

  const expense = await prisma.transactionType.upsert({
    where: { name: "expense" },
    update: {},
    create: { name: "expense" },
  });

  await prisma.category.createMany({
    data: [
      { name: "Iuran Warga", typeId: income.id },
      { name: "Donasi", typeId: income.id },
      { name: "Pemasukan Lain-lain", typeId: income.id },

      { name: "Operasional", typeId: expense.id },
      { name: "Setoran Yayasan Sampah", typeId: expense.id },
      { name: "Iuran RW Bulanan", typeId: expense.id },
      { name: "KKM RW", typeId: expense.id },
      { name: "Pengeluaran Lain-lain", typeId: expense.id },
      { name: "Perbaikan Lingkungan", typeId: expense.id },
    ],
    skipDuplicates: true,
  });
}

main()
  .then(() => console.log("Seed completed"))
  .catch((err) => console.error(err))
  .finally(() => prisma.$disconnect());
