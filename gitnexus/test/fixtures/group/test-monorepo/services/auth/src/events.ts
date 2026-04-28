export async function publishLoginEvent(producer: any, userId: string) {
  await producer.send({ topic: 'user.logged-in', messages: [{ value: userId }] });
}
