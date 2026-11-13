export function postgresOptions(env){
    let connectionString=env.DATABASE_URL;const mode=env.PGSSLMODE;
    const secure=['require','verify-ca','verify-full'].includes(mode);
    if(connectionString){try{const url=new URL(connectionString);if(secure||['require','verify-ca','verify-full'].includes(url.searchParams.get('sslmode')))url.searchParams.set('sslmode','verify-full');connectionString=url.toString();}catch{/* O driver informa uma conexão inválida sem exibir o segredo. */}}
    return {connectionString,ssl:secure?{rejectUnauthorized:true}:undefined};
}
