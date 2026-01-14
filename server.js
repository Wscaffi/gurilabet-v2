const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Conexão que não quebra o servidor se o banco falhar
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.get('/api/jogos', async (req, res) => {
    try {
        // Busca jogos reais com escudos e ligas
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=30', {
            headers: { 
                'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
                'x-rapidapi-host': 'v3.football.api-sports.io'
            }
        });

        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            odds: { 
                casa: (1.5 + Math.random()).toFixed(2), 
                empate: (3.0 + Math.random()).toFixed(2), 
                fora: (2.5 + Math.random()).toFixed(2) 
            }
        }));
        res.json(jogos);
    } catch (error) {
        // Plano B: Retorna jogos reais de exemplo se a API falhar para o site não ficar preto
        res.json([{
            liga: "Premier League", pais: "Inglaterra",
            home: {name: "Manchester City", logo: "https://media.api-sports.io/football/teams/50.png"},
            away: {name: "Liverpool", logo: "https://media.api-sports.io/football/teams/40.png"},
            data: new Date().toISOString(),
            odds: {casa: "1.90", empate: "3.50", fora: "4.10"}
        }]);
    }
});

app.post('/api/finalizar', async (req, res) => {
    const { valor, palpite, times, odd } = req.body;
    const codigo = "GB" + Math.floor(Math.random() * 90000 + 10000);
    const retorno = (valor * odd).toFixed(2);
    try {
        await pool.query('INSERT INTO bilhetes (codigo, valor, retorno, times, palpite) VALUES ($1, $2, $3, $4, $5)', [codigo, valor, retorno, times, palpite]);
    } catch (e) { console.log("Bilhete gerado sem salvar no banco offline"); }
    res.json({ codigo, retorno });
});

app.listen(process.env.PORT || 3000);
