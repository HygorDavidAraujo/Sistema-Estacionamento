export default async function teardown() {
    try {
        const login=await fetch('http://127.0.0.1:3108/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:'teste',senha:'Senha-teste-123'}),signal:AbortSignal.timeout(5000)});
        const data=await login.json();const cookie=login.headers.get('set-cookie')?.split(';')[0];
        if(cookie&&data.csrf)await fetch('http://127.0.0.1:3108/__shutdown',{method:'POST',headers:{Cookie:cookie,'x-csrf-token':data.csrf},signal:AbortSignal.timeout(5000)});
    }catch{/* Playwright também encerra o processo que ele próprio iniciou. */}
}
