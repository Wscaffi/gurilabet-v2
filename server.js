const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const API_KEY = process.env.API_FOOTBALL_KEY;

// --- CONFIGURAÇÃO DA BANCA (GESTÃO DE RISCO) ---
const MARGEM_LUCRO = 0.85; // Garante seus 15% de lucro
const GANHO_MAXIMO = 2500.00; // Trava para não quebrar a banca
const VALOR_MINIMO = 5.00; // Trava 1: Valor mínimo

app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?league=71&season=2024&next=15', {
            headers: { 'x-rapidapi-key': API_KEY }
        });

        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            data: j.fixture.date,
            odds: {
                casa: (2.10 * MARGEM_LUCRO).toFixed(2),
                empate: (3.20 * MARGEM_LUCRO).toFixed(2),
                fora: (3.80 * MARGEM_LUCRO).toFixed(2)
            }
        }));
        res.json(jogos);
    } catch (e) { res.status(500).send("Erro na API"); }
});

app.post('/api/finalizar', async (req, res) => {
    const { valor, palpite, jogoId, times, horario, odd } = req.body;
    
    // Trava de Horário: Não aceita aposta se o jogo já começou
    if (new Date(horario) <= new Date()) {
        return res.status(400).json({ erro: "Jogo já iniciado!" });
    }

    const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
    let retorno = (valor * odd);

    // Trava 2: Limite de prêmio
    if (retorno > GANHO_MAXIMO) retorno = GANHO_MAXIMO;

    try {
        await pool.query(
            'INSERT INTO bilhetes (codigo, valor, retorno_potencial, jogo_id, times, palpite, status, horario_jogo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [codigo, valor, retorno.toFixed(2), jogoId, times, palpite, 'pendente', horario]
        );
        res.json({ codigo, retorno: retorno.toFixed(2) });
    } catch (e) { res.status(500).json(e); }
});

app.listen(process.env.PORT || 3000);