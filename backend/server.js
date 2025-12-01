import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

// ROTA PARA CONSULTAR A PLACA USANDO BRASILAPI
app.get("/placa/:placa", async (req, res) => {
    const placa = req.params.placa;

    console.log("[BACK] Consultando placa:", placa);

    try {
        const response = await fetch(`https://brasilapi.com.br/api/placa/v1/${placa}`);

        // Se placa não existe na base
        if (response.status === 404) {
            console.log("[BACK] Placa não encontrada na BrasilAPI");
            return res.json({
                encontrado: false,
                marca: "Não encontrado",
                modelo: "Não encontrado",
                cor: ""
            });
        }

        if (!response.ok) {
            console.log("[BACK] Erro BrasilAPI:", response.status);
            return res.json({ encontrado: false });
        }

        const data = await response.json();

        return res.json({
            encontrado: true,
            marca: data.marca || "",
            modelo: data.modelo || "",
            ano: data.ano || "",
            cor: ""
        });

    } catch (error) {
        console.error("[BACK] ERRO AO CONSULTAR:", error);
        return res.json({ encontrado: false });
    }
});


// INICIAR SERVIDOR
app.listen(3000, () => {
    console.log("Servidor rodando na porta 3000");
});
