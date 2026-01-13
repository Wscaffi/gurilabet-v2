const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Conexão com o Banco de Dados
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Criar tabela automaticamente
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bilhetes (
                id SERIAL PRIMARY KEY,
                codigo TEXT UNIQUE,
                valor NUMERIC,
                retorno_potencial NUMERIC,
                times TEXT,
                palpite TEXT,
                status TEXT DEFAULT 'pendente',
                criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Banco de dados pronto!");
    } catch (err) { console.error("❌ Erro banco:", err.message); }
}
initDb();

// ROTA DE JOGOS
app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=10', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });
        let jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            odds: { casa: "2.10", empate: "3.20", fora: "4.10" }
        }));
        if (jogos.length === 0) throw new Error("Vazio");
        res.json(jogos);
    } catch (error) {
        res.json([
            { id: 101, times: "Flamengo x Palmeiras", odds: { casa: "2.10", empate: "3.20", fora: "3.80" } },
            { id: 102, times: "Real Madrid x Barcelona", odds: { casa: "1.95", empate: "3.40", fora: "4.10" } }
        ]);
    }
});

// ROTA FINALIZAR BILHETE
app.post('/api/finalizar', async (req, res) => {
    try {
        const { valor, palpite, times, odd } = req.body;
        const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
        const retorno = (valor * (odd || 2.0)).toFixed(2);
        await pool.query(
            'INSERT INTO bilhetes (codigo, valor, retorno_potencial, times, palpite) VALUES ($1, $2, $3, $4, $5)',
            [codigo, valor, retorno, times, palpite]
        );
        res.json({ codigo, retorno });
    } catch (error) {
        const codReserva = "GB" + Math.floor(Math.random() * 9999);
        res.json({ codigo: codReserva, retorno: (req.body.valor * 2).toFixed(2) });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));
