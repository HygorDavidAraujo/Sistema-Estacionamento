export default async function teardown() {
    await fetch('http://127.0.0.1:3108/__shutdown', { method: 'POST' }).catch(() => {});
}
