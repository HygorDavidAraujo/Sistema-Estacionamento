export function createVehicleRepository(query, ready = () => true) {
    return {
        async get(plate) {
            if (!await ready()) return null;
            const cached = await query('SELECT marca, modelo, cor, expira_em, atualizado_em FROM veiculos_cache WHERE placa = $1 AND expira_em > NOW()', [plate]);
            if (cached.rows[0]) return cached.rows[0];
            const history = await query(`SELECT marca, modelo, cor, criado_em AS atualizado_em
                FROM historico WHERE placa = $1 AND marca <> '' AND modelo <> '' AND cor <> ''
                ORDER BY criado_em DESC LIMIT 1`, [plate]);
            return history.rows[0] || null;
        },
        async set(plate, data, source, expires) {
            if (!await ready()) return;
            await query(`INSERT INTO veiculos_cache (placa, marca, modelo, cor, origem, expira_em)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (placa) DO UPDATE SET marca = EXCLUDED.marca, modelo = EXCLUDED.modelo,
                cor = EXCLUDED.cor, origem = EXCLUDED.origem, expira_em = EXCLUDED.expira_em, atualizado_em = NOW()`,
            [plate, data.marca, data.modelo, data.cor, source, expires]);
        }
    };
}
