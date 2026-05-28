const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const QR_DIR = path.join(DATA_DIR, 'qrcodes');
const DATA_FILE = path.join(DATA_DIR, 'species.json');

app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/qrcodes', express.static(QR_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.json({ limit: '500mb' }));

[UPLOADS_DIR, QR_DIR, path.dirname(DATA_FILE)].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.glb', '.gltf', '.ply', '.obj', '.mtl', '.png', '.jpg', '.jpeg', '.bin'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Formato no permitido. Usa GLB, GLTF, OBJ con MTL y texturas.'));
  },
  limits: { fileSize: 500 * 1024 * 1024 }
});

function loadSpecies() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return raw.map(normalizeSpecies);
    }
    return [];
  } catch { return []; }
}

function normalizeSpecies(item) {
  return {
    id: item.id || uuidv4(),
    name: item.name || item.commonName || 'Sin nombre',
    scientificName: item.scientificName || '',
    description: item.description || '',
    habitat: item.habitat || '',
    modelPath: item.modelPath || item.fileUrl || '',
    modelFormat: item.modelFormat || item.fileExt || '',
    modelType: item.modelType || 'mesh',
    thumbnail: item.thumbnail || null,
    textures: item.textures || [],
    arScale: item.arScale || 'auto',
    createdAt: item.createdAt || new Date().toISOString()
  };
}

function saveSpecies(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

app.get('/', (req, res) => {
  const species = loadSpecies();
  res.render('layout', { body: 'index', species, title: 'Catálogo de Especies' });
});

app.get('/admin', (req, res) => {
  const species = loadSpecies();
  res.render('layout', { body: 'admin', species, title: 'Administración', query: req.query });
});

app.get('/especie/:id', async (req, res) => {
  const species = loadSpecies().find(s => s.id === req.params.id);
  if (!species) return res.status(404).render('layout', { body: '404', title: 'No encontrado' });

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const qrUrl = `${baseUrl}/especie/${species.id}`;
  const qrFilename = `qr-${species.id}.png`;
  const qrPath = path.join(QR_DIR, qrFilename);

  if (!fs.existsSync(qrPath)) {
    await QRCode.toFile(qrPath, qrUrl, { width: 512, margin: 2, color: { dark: '#1a1a2e', light: '#ffffff' } });
  }

  species.qrCode = `/qrcodes/${qrFilename}`;
  species.qrUrl = qrUrl;
  const isGLB = species.modelFormat === '.glb' || species.modelFormat === '.gltf';
  const hasTextures = species.textures && species.textures.length > 0;
  res.render('layout', { body: 'species', species, title: species.name, isGLB, hasTextures });
});

app.post('/admin/upload', upload.fields([
  { name: 'model', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'textures', maxCount: 10 }
]), (req, res) => {
  try {
    const { name, scientificName, description, habitat, arScale } = req.body;
    const modelFile = req.files['model'] ? req.files['model'][0] : null;
    const thumbFile = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;
    const textureFiles = req.files['textures'] || [];

    if (!name || !modelFile) {
      return res.status(400).send('<script>alert("Nombre y modelo 3D son obligatorios"); window.location="/admin";</script>');
    }

    const species = loadSpecies();
    const newSpecies = {
      id: uuidv4(),
      name,
      scientificName: scientificName || '',
      description: description || '',
      habitat: habitat || '',
      modelPath: '/uploads/' + modelFile.filename,
      modelFormat: path.extname(modelFile.originalname).toLowerCase(),
      thumbnail: thumbFile ? '/uploads/' + thumbFile.filename : null,
      textures: textureFiles.map(f => ({ name: f.originalname, path: '/uploads/' + f.filename })),
      arScale: arScale || 'auto',
      createdAt: new Date().toISOString()
    };

    species.push(newSpecies);
    saveSpecies(species);
    res.redirect('/admin?uploaded=1');
  } catch (err) {
    console.error(err);
    res.status(500).send('<script>alert("Error al subir: ' + err.message + '"); window.location="/admin";</script>');
  }
});

app.post('/admin/delete/:id', (req, res) => {
  let species = loadSpecies();
  const item = species.find(s => s.id === req.params.id);
  if (item) {
    const modelFilePath = path.join(UPLOADS_DIR, path.basename(item.modelPath));
    const qrPath = path.join(QR_DIR, `qr-${item.id}.png`);
    if (item.thumbnail) {
      const thumbPath = path.join(UPLOADS_DIR, path.basename(item.thumbnail));
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    }
    if (item.textures) {
      item.textures.forEach(t => {
        const texPath = path.join(UPLOADS_DIR, path.basename(t.path));
        if (fs.existsSync(texPath)) fs.unlinkSync(texPath);
      });
    }
    if (fs.existsSync(modelFilePath)) fs.unlinkSync(modelFilePath);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
  }
  species = species.filter(s => s.id !== req.params.id);
  saveSpecies(species);
  res.redirect('/admin?deleted=1');
});

app.get('/api/species', (req, res) => {
  res.json(loadSpecies());
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
