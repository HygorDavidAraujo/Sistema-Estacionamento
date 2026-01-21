(function() {
    const STORAGE_KEY = 'parkingEntries';
    const IGNORE_KEYS = new Set(['valorHora', 'valorHoraAdicional', 'toleranciaHoraAdicional', 'vehicleDB', STORAGE_KEY, 'totalVagas']);

    const normalizePlaca = (p) => (p || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

    function loadEntries() {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            console.warn('[storage.service] Não foi possível ler entradas, limpando cache.', err);
            return [];
        }
    }

    function persist(entries) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }

    function generateEntryId() {
        return `ent-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    }

    function mirrorLegacy(entry) {
        const legacy = {
            placa: entry.placa,
            marca: entry.marca,
            modelo: entry.modelo,
            cor: entry.cor,
            horaEntrada: entry.horaEntrada
        };
        localStorage.setItem(entry.placa, JSON.stringify(legacy));
    }

    function saveEntry(entry) {
        const normalizedEntry = { ...entry, placa: normalizePlaca(entry.placa) };
        const entries = loadEntries();
        const existingByPlate = entries.find(e => e.placa === normalizedEntry.placa && e.entryId !== normalizedEntry.entryId);
        const existingIndexById = entries.findIndex(e => e.entryId === normalizedEntry.entryId);

        // Não sobrescreve se já existe veículo com a mesma placa ativo
        if (existingByPlate) {
            return existingByPlate;
        }

        if (existingIndexById >= 0) {
            entries[existingIndexById] = normalizedEntry;
        } else {
            entries.push(normalizedEntry);
        }

        persist(entries);
        mirrorLegacy(normalizedEntry);
        return normalizedEntry;
    }

    function removeEntry(entryId) {
        const entries = loadEntries();
        const remaining = entries.filter(e => e.entryId !== entryId);
        const removed = entries.find(e => e.entryId === entryId);
        persist(remaining);
        if (removed) localStorage.removeItem(removed.placa);
    }

    function getEntryByPlate(placa) {
        const normalized = normalizePlaca(placa);
        if (!normalized) return null;
        const entries = loadEntries();
        const found = entries.find(e => e.placa === normalized);
        if (found) return found;
        // fallback legacy
        const legacyRaw = localStorage.getItem(normalized);
        if (!legacyRaw) return null;
        try {
            const legacy = JSON.parse(legacyRaw);
            if (!legacy.horaEntrada) return null;
            const entry = {
                entryId: generateEntryId(),
                placa: normalized,
                marca: legacy.marca || '',
                modelo: legacy.modelo || '',
                cor: legacy.cor || '',
                horaEntrada: legacy.horaEntrada
            };
            saveEntry(entry);
            return entry;
        } catch (err) {
            return null;
        }
    }

    function getEntryById(entryId) {
        if (!entryId) return null;
        return loadEntries().find(e => e.entryId === entryId) || null;
    }

    function listActiveEntries() {
        return loadEntries();
    }

    function migrateLegacyEntries() {
        const entries = loadEntries();
        let changed = false;
        Object.keys(localStorage).forEach((key) => {
            if (IGNORE_KEYS.has(key)) return;
            if (key.startsWith('ent-')) return;
            if (key === STORAGE_KEY) return;
            try {
                const legacy = JSON.parse(localStorage.getItem(key));
                if (!legacy || !legacy.horaEntrada) return;
                const normalized = normalizePlaca(legacy.placa || key);
                const already = entries.find(e => e.placa === normalized);
                if (already) return;
                entries.push({
                    entryId: generateEntryId(),
                    placa: normalized,
                    marca: legacy.marca || '',
                    modelo: legacy.modelo || '',
                    cor: legacy.cor || '',
                    horaEntrada: legacy.horaEntrada
                });
                changed = true;
            } catch (err) {
                // ignore broken legacy entries
            }
        });
        if (changed) persist(entries);
    }

    window.StorageService = {
        generateEntryId,
        saveEntry,
        removeEntry,
        getEntryByPlate,
        getEntryById,
        listActiveEntries,
        migrateLegacyEntries
    };

    // auto-migrate on load
    try { migrateLegacyEntries(); } catch (err) { console.warn('[storage.service] migração falhou', err); }
})();
