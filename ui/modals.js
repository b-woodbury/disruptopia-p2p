// ── DISCARD MODALS ────────────────────────────────────────
async function promptDiscardIfNeeded(playerId) {
    refreshData();
    const pData = Game.currentGameState?.players.find(p => p.id === playerId);
    if (!pData) return;
    const limit = pData.hand_limit || 5;
    while (pData.hand && pData.hand.length > limit) {
        await new Promise(resolve => {
            Game.isDiscarding = false;
            const check = setInterval(() => {
                if (!Game.isDiscarding) { clearInterval(check); resolve(); }
            }, 200);
            checkHandLimit(pData);
        });
        refreshData();
        const updated = Game.currentGameState?.players.find(p => p.id === playerId);
        if (updated) { pData.hand = updated.hand; }
        else break;
    }
}

function promptDiscardModal(player, limit) {
    Game.isDiscarding = true;
    Game.discardSelectedCard = null;
    const discardPlayerId = player.id; // Capture the correct player ID for the API call
    const modal = document.getElementById('choice-modal');
    const titleEl = document.getElementById('modal-title');
    const descEl = document.getElementById('modal-desc');
    const optionsEl = document.getElementById('modal-options');

    titleEl.innerText = `${player.name} - Hand Limit Exceeded`;
    descEl.innerText = `${player.name} has ${player.hand.length} cards (limit ${limit}). Tap a card to preview, then confirm discard.`;
    optionsEl.innerHTML = "";
    optionsEl.style.cssText = "display:flex; flex-wrap:wrap; justify-content:center; gap:8px; max-height:65vh; overflow-y:auto; position:relative;";

    // Preview area (hidden until a card is selected)
    const preview = document.createElement('div');
    preview.id = 'discard-preview';
    preview.style.cssText = "display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:200; text-align:center;";

    player.hand.forEach(card => {
        const imgPath = card.image_file ? `assets/${card.image_file}` : '';
        const isInternProtected = card.effect_slug === 'intern_program';
        const w = document.createElement('div');
        w.style.cssText = `cursor:${isInternProtected ? 'not-allowed' : 'pointer'}; border:2px solid ${isInternProtected ? '#d4c9b8' : '#dc2626'}; border-radius:8px; overflow:hidden; width:140px; flex-shrink:0; transition:transform 0.2s; ${isInternProtected ? 'opacity:0.35; filter:grayscale(0.8);' : ''}`;
        w.innerHTML = `<img src="${imgPath}" style="width:100%; height:auto; display:block;" onerror="this.style.display='none'">
            <div style="padding:4px; text-align:center; font-size:0.65rem; background:${isInternProtected ? '#f5f0e8' : '#fef2f2'}; color:${isInternProtected ? '#78716c' : '#dc2626'}; font-weight:500;">${isInternProtected ? 'Cannot be discarded' : 'DISCARD'}</div>`;

        if (isInternProtected) {
            // Intern Program cards cannot be discarded
            optionsEl.appendChild(w);
            return;
        }

        // Desktop: hover to enlarge
        w.onmouseenter = () => {
            if (Game.discardSelectedCard) return; // Don't hover-enlarge while confirming
            w.style.transform = "scale(1.6)";
            w.style.zIndex = "10";
            w.style.position = "relative";
        };
        w.onmouseleave = () => {
            w.style.transform = "scale(1)";
            w.style.zIndex = "";
            w.style.position = "";
        };

        // Click/tap: show enlarged preview + confirm button
        w.onclick = () => {
            Game.discardSelectedCard = card;
            // Show preview overlay
            preview.style.display = 'block';
            preview.innerHTML = `
                <div style="background:#ffffff; border:2px solid #dc2626; border-radius:12px; overflow:hidden; width:280px; box-shadow:0 8px 32px rgba(0,0,0,0.18);">
                    <img src="${imgPath}" style="width:100%; height:auto; display:block;" onerror="this.style.display='none'">
                    <div style="padding:10px; display:flex; gap:8px; justify-content:center; background:#fef2f2;">
                        <button id="discard-confirm-btn" style="padding:8px 20px; background:#dc2626; color:#fff; border:none; cursor:pointer; font-weight:bold; font-size:0.8rem; border-radius:8px;">DISCARD</button>
                        <button id="discard-cancel-btn" style="padding:8px 20px; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; cursor:pointer; font-size:0.8rem; border-radius:8px;">BACK</button>
                    </div>
                </div>
            `;
            // Dim the card grid behind
            optionsEl.style.opacity = '0.3';
            optionsEl.style.pointerEvents = 'none';

            document.getElementById('discard-confirm-btn').onclick = async () => {
                preview.style.display = 'none';
                modal.style.display = "none";
                optionsEl.style.cssText = "";
                Game.discardSelectedCard = null;
                const result = Engine.discardCard(Game.localState, discardPlayerId, card.id);
                if (result.error) { showErrorModal("Discard Failed", result.error); }
                else if (typeof broadcastAction === 'function') {
                    broadcastAction({kind: 'discard', args: {playerId: discardPlayerId, cardId: card.id}});
                }
                Game.isDiscarding = false;
                refreshData();
            };
            document.getElementById('discard-cancel-btn').onclick = () => {
                preview.style.display = 'none';
                optionsEl.style.opacity = '';
                optionsEl.style.pointerEvents = '';
                Game.discardSelectedCard = null;
            };
        };

        optionsEl.appendChild(w);
    });

    // Clean up any old preview, then add new one
    const oldPreview = document.getElementById('discard-preview');
    if (oldPreview) oldPreview.remove();
    modal.querySelector(':scope > div').appendChild(preview);
    modal.style.display = "flex";
}

// ── CARD CHOICE ───────────────────────────────────────────
function promptCardChoice(title, desc, cards, maxWorkers, costReduction, player = null) {
    return new Promise(resolve => {
        const modal = document.getElementById('choice-modal');
        document.getElementById('modal-title').innerText = title;
        document.getElementById('modal-desc').innerText = desc;
        const opts = document.getElementById('modal-options');
        opts.innerHTML = "";

        // Clean up any leftover preview from previous calls
        modal.querySelectorAll('.card-preview-overlay').forEach(el => el.remove());

        const gridStyle = "display:flex; flex-wrap:wrap; justify-content:center; gap:8px; max-height:65vh; overflow-y:auto;";
        opts.style.cssText = gridStyle;

        const preview = document.createElement('div');
        preview.className = 'card-preview-overlay';
        preview.style.cssText = "display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:200; text-align:center;";

        function cleanup() {
            preview.remove();
            opts.style.cssText = '';
        }

        cards.forEach(card => {
            const actualCost = Math.max(0, card.cost - costReduction);
            const workerOk = actualCost <= maxWorkers;
            const reqCheck = player ? checkCardRequirements(card, player) : {met: true};
            const canAfford = workerOk && reqCheck.met;
            const img = card.image_file ? `assets/${card.image_file}` : '';
            const costLabel = actualCost > 0 ? `${actualCost}W` : 'Free';

            const w = document.createElement('div');
            w.style.cssText = `width:160px; flex-shrink:0; border-radius:8px; overflow:hidden; border:2px solid ${canAfford ? '#4f46e5' : '#d4c9b8'}; transition:transform 0.2s; box-shadow:0 2px 8px rgba(0,0,0,0.08); ${canAfford ? 'cursor:pointer;' : 'opacity:0.35; cursor:not-allowed;'}`;
            if (canAfford) {
                w.onmouseenter = () => { if (preview.style.display === 'none') { w.style.transform = 'scale(1.6)'; w.style.zIndex = '10'; w.style.position = 'relative'; } };
                w.onmouseleave = () => { w.style.transform = 'scale(1)'; w.style.zIndex = ''; w.style.position = ''; };
                w.onclick = () => {
                    // Reset any hover state
                    w.style.transform = 'scale(1)'; w.style.zIndex = ''; w.style.position = '';
                    preview.style.display = 'block';
                    preview.innerHTML = `
                        <div style="background:#ffffff; border:2px solid #4f46e5; border-radius:12px; overflow:hidden; width:280px; box-shadow:0 8px 32px rgba(0,0,0,0.18);">
                            <img src="${img}" style="width:100%; height:auto; display:block;" onerror="this.style.display='none'">
                            <div style="padding:10px; display:flex; gap:8px; justify-content:center; background:#eef2ff;">
                                <button class="play-confirm" style="padding:8px 20px; background:#4f46e5; color:#fff; border:none; cursor:pointer; font-weight:bold; font-size:0.8rem; border-radius:8px;">PLAY (${costLabel})</button>
                                <button class="play-back" style="padding:8px 20px; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; cursor:pointer; font-size:0.8rem; border-radius:8px;">BACK</button>
                            </div>
                        </div>`;
                    opts.style.opacity = '0.3';
                    opts.style.pointerEvents = 'none';
                    preview.querySelector('.play-confirm').onclick = () => {
                        cleanup(); modal.style.display = 'none'; resolve(card);
                    };
                    preview.querySelector('.play-back').onclick = () => {
                        preview.style.display = 'none';
                        opts.style.cssText = gridStyle;
                    };
                };
            }
            const unavailReason = !workerOk ? `Need ${actualCost}W` : (!reqCheck.met ? reqCheck.reason : '');
            w.innerHTML = `<img src="${img}" style="width:100%; height:auto; display:block;" onerror="this.style.height='120px'; this.style.background='#f5f0e8';">
                <div style="padding:3px; font-size:0.65rem; text-align:center; background:${canAfford ? '#eef2ff' : '#fef2f2'}; color:${canAfford ? '#4f46e5' : '#dc2626'}; font-weight:500;">${costLabel}${canAfford ? '' : ' - ' + unavailReason}</div>`;
            opts.appendChild(w);
        });

        modal.querySelector(':scope > div').appendChild(preview);

        const cancel = document.createElement('button');
        cancel.innerText = "Cancel";
        cancel.style.cssText = "padding:8px 16px; cursor:pointer; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; width:100%; margin-top:8px; border-radius:8px;";
        cancel.onclick = () => { cleanup(); modal.style.display = 'none'; resolve(null); };
        opts.appendChild(cancel);

        modal.style.display = "flex";
    });
}

// ── MAP REGION PICKER ─────────────────────────────────────
function promptMapRegionChoice(title, desc, validRegionIds) {
    return new Promise(resolve => {
        const modal = document.getElementById('choice-modal');
        const titleEl = document.getElementById('modal-title');
        const descEl = document.getElementById('modal-desc');
        const optionsEl = document.getElementById('modal-options');

        titleEl.innerText = title;
        descEl.innerText = desc;
        optionsEl.innerHTML = "";

        const wrap = document.createElement('div');
        wrap.style.cssText = "position:relative; line-height:0; margin:8px 0;";
        wrap.innerHTML = `<img src="WorldMap.png" style="width:100%; height:auto; border:1px solid #d4c9b8; border-radius:8px; opacity:0.8;">`;
        const ov = document.createElement('div');
        ov.style.cssText = "position:absolute; top:0; left:0; width:100%; height:100%;";

        REGION_LAYOUT.forEach(layout => {
            const region = Game.currentGameState.regions?.find(r => r.id === layout.id);
            const pp = region ? (region.presence_players||[]) : [];
            const isValid = validRegionIds.has(layout.id);

            const m = document.createElement('div');
            const rw = layout.w || 18;
            const rh = layout.h || 46;
            m.style.cssText = `position:absolute; left:${layout.x}%; top:${layout.y}%; transform:translate(-50%,-50%);
                width:${rw}%; height:${rh}%; display:flex; flex-direction:column; align-items:center; justify-content:center;
                border-radius:4px; font-size:0.7rem; font-weight:bold; transition:background 0.15s;`;

            // Build info labels for any region
            const subsidies = region ? region.subsidy_tokens : 0;
            const tokenHtml = subsidies > 0 ? `<span style="color:#ffcc00;">${'*'.repeat(subsidies)}</span> ` : '';
            const playersHtml = pp.length > 0 ? pp.map(n => {
                const o = Game.currentGameState.players.find(p => p.name === n);
                return o ? `<span style="color:${PLAYER_COLORS[o.id]||'#888'};">${o.name.split(' ').map(w=>w[0]).join('')}</span>` : '';
            }).join(' ') : '';

            if (isValid) {
                m.style.background = 'rgba(79,70,229,0.15)';
                m.style.border = '2px solid #4f46e5';
                m.style.color = '#4f46e5';
                m.style.cursor = 'pointer';
                m.innerHTML = `<div>${REGIONS[layout.id-1]}</div><div style="font-size:0.6rem;">${tokenHtml}${playersHtml}</div>`;
                m.onmouseenter = () => { m.style.background = '#4f46e5'; m.style.color = '#fff'; };
                m.onmouseleave = () => { m.style.background = 'rgba(79,70,229,0.15)'; m.style.color = '#4f46e5'; };
                m.onclick = () => { modal.style.display = 'none'; resolve(layout.id); };
            } else {
                m.style.background = 'rgba(0,0,0,0.25)';
                m.style.border = '1px solid #d4c9b8';
                m.style.color = '#78716c';
                m.innerHTML = `<div style="font-size:0.6rem;">${tokenHtml}${playersHtml}</div>`;
            }
            ov.appendChild(m);
        });

        wrap.appendChild(ov);
        optionsEl.appendChild(wrap);

        const cancelBtn = document.createElement('button');
        cancelBtn.innerText = "Cancel";
        cancelBtn.style.cssText = "padding:8px 16px; margin-top:8px; cursor:pointer; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; border-radius:8px;";
        cancelBtn.onclick = () => { modal.style.display = 'none'; resolve(null); };
        optionsEl.appendChild(cancelBtn);

        modal.style.display = "flex";
    });
}

// ── TARGET CHOICE ─────────────────────────────────────────
function promptTargetChoiceWithCard(attacker, card, opponents) {
    // Same as promptTargetChoice but shows the card image and uses full stat names
    return promptTargetChoice(attacker, card, opponents);
}

function promptTargetChoice(attacker, card, opponents) {
    return new Promise(resolve => {
        const modal = document.getElementById('choice-modal');
        document.getElementById('modal-title').innerText = `${attacker.name} - Select Target`;
        document.getElementById('modal-desc').innerText = "Choose who to target. Click an opponent to preview their stats.";
        const opts = document.getElementById('modal-options');
        opts.innerHTML = "";
        opts.style.cssText = "display:flex; flex-direction:column; gap:8px;";

        // Show the card being played
        const cardImg = card.image_file ? `assets/${card.image_file}` : '';
        if (cardImg) {
            const cardPreview = document.createElement('div');
            cardPreview.style.cssText = "text-align:center; margin-bottom:8px;";
            cardPreview.innerHTML = `<img src="${cardImg}" style="width:160px; height:auto; border:1px solid #dc2626; border-radius:8px;">`;
            opts.appendChild(cardPreview);
        }

        const previewArea = document.createElement('div');
        previewArea.id = 'target-preview';
        previewArea.style.cssText = "display:none; border:1px solid #d4c9b8; border-radius:8px; padding:10px; background:#faf7f2; margin-top:8px;";

        opponents.forEach(opp => {
            const btn = document.createElement('button');
            btn.style.cssText = "padding:10px; cursor:pointer; background:#ffffff; color:#1e1b18; border:1px solid #d4c9b8; text-align:left; display:flex; justify-content:space-between; align-items:center; border-radius:8px; font-family:'Inter',system-ui,sans-serif;";
            btn.innerHTML = `
                <span style="font-weight:600;">${opp.name}</span>
                <span style="font-size:0.7rem; color:#78716c;">Power: ${opp.power} | Funds: $${opp.corporate_funds} | Rep: ${opp.reputation} | Compute: ${opp.compute_level} | Model: v${opp.model_version} | Workers: ${opp.total_worker_count}</span>
            `;

            btn.onclick = () => {
                // Show detailed preview
                previewArea.style.display = 'block';
                previewArea.innerHTML = `
                    <div style="font-weight:bold; font-size:0.9rem; margin-bottom:8px; color:#dc2626;">Target: ${opp.name}</div>
                    <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:6px; font-size:0.7rem; margin-bottom:10px;">
                        <div style="text-align:center; border:1px solid #e5ddd0; padding:4px; background:#ffffff; border-radius:6px;"><div style="color:#78716c; font-size:0.55rem;">Power</div><div style="font-weight:bold; color:#1e1b18;">${opp.power}</div></div>
                        <div style="text-align:center; border:1px solid #e5ddd0; padding:4px; background:#ffffff; border-radius:6px;"><div style="color:#78716c; font-size:0.55rem;">Corp Funds</div><div style="font-weight:bold; color:#1e1b18;">$${opp.corporate_funds}</div></div>
                        <div style="text-align:center; border:1px solid #e5ddd0; padding:4px; background:#ffffff; border-radius:6px;"><div style="color:#78716c; font-size:0.55rem;">Reputation</div><div style="font-weight:bold; color:#1e1b18;">${opp.reputation}</div></div>
                        <div style="text-align:center; border:1px solid #e5ddd0; padding:4px; background:#ffffff; border-radius:6px;"><div style="color:#78716c; font-size:0.55rem;">Workers</div><div style="font-weight:bold; color:#1e1b18;">${opp.total_worker_count}</div></div>
                        <div style="text-align:center; border:1px solid #e5ddd0; padding:4px; background:#ffffff; border-radius:6px;"><div style="color:#78716c; font-size:0.55rem;">Compute</div><div style="font-weight:bold; color:#1e1b18;">${opp.compute_level}</div></div>
                        <div style="text-align:center; border:1px solid #e5ddd0; padding:4px; background:#ffffff; border-radius:6px;"><div style="color:#78716c; font-size:0.55rem;">Model</div><div style="font-weight:bold; color:#1e1b18;">v${opp.model_version}</div></div>
                        <div style="text-align:center; border:1px solid #e5ddd0; padding:4px; background:#ffffff; border-radius:6px;"><div style="color:#78716c; font-size:0.55rem;">Subsidies</div><div style="font-weight:bold; color:#1e1b18;">${opp.subsidy_tokens}</div></div>
                        <div style="text-align:center; border:1px solid #e5ddd0; padding:4px; background:#ffffff; border-radius:6px;"><div style="color:#78716c; font-size:0.55rem;">Regions</div><div style="font-weight:bold; color:#1e1b18;">${opp.presence_count}</div></div>
                    </div>
                    <div style="display:flex; gap:8px; justify-content:center;">
                        <button id="target-confirm" style="padding:8px 20px; background:#dc2626; color:#fff; border:none; cursor:pointer; font-weight:bold; border-radius:8px;">ATTACK ${opp.name.toUpperCase()}</button>
                        <button id="target-back" style="padding:8px 20px; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; cursor:pointer; border-radius:8px;">BACK</button>
                    </div>
                `;
                document.getElementById('target-confirm').onclick = () => {
                    modal.style.display = 'none'; opts.style.cssText = ''; resolve(opp.id);
                };
                document.getElementById('target-back').onclick = () => {
                    previewArea.style.display = 'none';
                };
            };
            opts.appendChild(btn);
        });

        opts.appendChild(previewArea);

        const cancel = document.createElement('button');
        cancel.innerText = "Cancel";
        cancel.style.cssText = "padding:8px; cursor:pointer; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; border-radius:8px;";
        cancel.onclick = () => { modal.style.display='none'; opts.style.cssText=''; resolve(null); };
        opts.appendChild(cancel);

        modal.style.display = "flex";
    });
}

// ── USER CHOICE ───────────────────────────────────────────
function promptUserChoice(title, desc, options, validator = null) {
    return new Promise(resolve => {
        const modal = document.getElementById('choice-modal');
        document.getElementById('modal-title').innerText = title;
        document.getElementById('modal-desc').innerText = desc;
        const opts = document.getElementById('modal-options');
        opts.innerHTML = "";
        opts.style.cssText = "display:flex; flex-direction:column; gap:6px;";

        options.forEach(opt => {
            if (validator && !validator(opt)) return;
            const btn = document.createElement('button');
            btn.innerText = opt;
            btn.style.cssText = "padding:8px; cursor:pointer; background:#ffffff; color:#1e1b18; border:1px solid #d4c9b8; text-align:left; border-radius:8px; font-family:'Inter',system-ui,sans-serif;";
            btn.onclick = () => { modal.style.display='none'; opts.style.cssText=''; resolve(opt); };
            opts.appendChild(btn);
        });

        const cancel = document.createElement('button');
        cancel.innerText = opts.children.length === 0 ? "No Valid Options - Close" : "Cancel";
        cancel.style.cssText = "padding:8px; cursor:pointer; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; border-radius:8px;";
        cancel.onclick = () => { modal.style.display='none'; opts.style.cssText=''; resolve(null); };
        opts.appendChild(cancel);

        modal.style.display = "flex";
    });
}

// ── FORCED DISCARD ────────────────────────────────────────
function promptForcedDiscardModal(interaction, respondingName) {
    return new Promise(resolve => {
        const modal = document.getElementById('choice-modal');
        const titleEl = document.getElementById('modal-title');
        const descEl = document.getElementById('modal-desc');
        const opts = document.getElementById('modal-options');

        titleEl.innerText = `${interaction.card_name}: ${respondingName} must discard a card`;
        descEl.innerText = `Choose ${interaction.count || 1} card(s) to discard.`;
        opts.innerHTML = "";
        opts.style.cssText = "display:flex; flex-wrap:wrap; justify-content:center; gap:8px; max-height:65vh; overflow-y:auto; position:relative;";

        modal.querySelectorAll('.card-preview-overlay').forEach(el => el.remove());

        const preview = document.createElement('div');
        preview.className = 'card-preview-overlay';
        preview.style.cssText = "display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:200; text-align:center;";

        const excludeSlugs = interaction.exclude_slugs || [];

        (interaction.cards || []).forEach(card => {
            const isProtected = excludeSlugs.includes(card.effect_slug);
            const imgPath = card.image_file ? `assets/${card.image_file}` : '';
            const w = document.createElement('div');
            w.style.cssText = `cursor:${isProtected ? 'not-allowed' : 'pointer'}; border:2px solid ${isProtected ? '#d4c9b8' : '#dc2626'}; border-radius:8px; overflow:hidden; width:140px; flex-shrink:0; transition:transform 0.2s; ${isProtected ? 'opacity:0.35; filter:grayscale(0.8);' : ''}`;
            w.innerHTML = `<img src="${imgPath}" style="width:100%; height:auto; display:block;" onerror="this.style.display='none'">
                <div style="padding:4px; text-align:center; font-size:0.65rem; background:${isProtected ? '#f5f0e8' : '#fef2f2'}; color:${isProtected ? '#78716c' : '#dc2626'}; font-weight:500;">${isProtected ? 'Cannot be discarded' : 'DISCARD'}</div>`;

            if (!isProtected) {
                w.onmouseenter = () => { if (preview.style.display === 'none') { w.style.transform = 'scale(1.6)'; w.style.zIndex = '10'; w.style.position = 'relative'; } };
                w.onmouseleave = () => { w.style.transform = 'scale(1)'; w.style.zIndex = ''; w.style.position = ''; };
                w.onclick = () => {
                    w.style.transform = 'scale(1)'; w.style.zIndex = ''; w.style.position = '';
                    preview.style.display = 'block';
                    preview.innerHTML = `
                        <div style="background:#ffffff; border:2px solid #dc2626; border-radius:12px; overflow:hidden; width:280px; box-shadow:0 8px 32px rgba(0,0,0,0.18);">
                            <img src="${imgPath}" style="width:100%; height:auto; display:block;" onerror="this.style.display='none'">
                            <div style="padding:10px; display:flex; gap:8px; justify-content:center; background:#fef2f2;">
                                <button class="discard-yes" style="padding:8px 20px; background:#dc2626; color:#fff; border:none; cursor:pointer; font-weight:bold; font-size:0.8rem; border-radius:8px;">DISCARD</button>
                                <button class="discard-no" style="padding:8px 20px; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; cursor:pointer; font-size:0.8rem; border-radius:8px;">BACK</button>
                            </div>
                        </div>`;
                    opts.style.opacity = '0.3';
                    opts.style.pointerEvents = 'none';
                    preview.querySelector('.discard-yes').onclick = () => {
                        preview.remove(); modal.style.display = 'none'; opts.style.cssText = '';
                        resolve({card_id: card.id});
                    };
                    preview.querySelector('.discard-no').onclick = () => {
                        preview.style.display = 'none';
                        opts.style.opacity = ''; opts.style.pointerEvents = '';
                    };
                };
            }
            opts.appendChild(w);
        });

        modal.querySelector(':scope > div').appendChild(preview);
        modal.style.display = "flex";
    });
}

// ── STEAL CARD ────────────────────────────────────────────
function promptStealCardModal(interaction) {
    return new Promise(resolve => {
        const modal = document.getElementById('choice-modal');
        const titleEl = document.getElementById('modal-title');
        const descEl = document.getElementById('modal-desc');
        const opts = document.getElementById('modal-options');

        titleEl.innerText = `Nefarious Schemings: Choose a card to steal from ${interaction.target_player_name}`;
        descEl.innerText = "Click a card to steal it.";
        opts.innerHTML = "";
        opts.style.cssText = "display:flex; flex-wrap:wrap; justify-content:center; gap:8px; max-height:65vh; overflow-y:auto; position:relative;";

        modal.querySelectorAll('.card-preview-overlay').forEach(el => el.remove());

        const preview = document.createElement('div');
        preview.className = 'card-preview-overlay';
        preview.style.cssText = "display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:200; text-align:center;";

        (interaction.target_hand || []).forEach(card => {
            const imgPath = card.image_file ? `assets/${card.image_file}` : '';
            const w = document.createElement('div');
            w.style.cssText = "cursor:pointer; border:2px solid #d97706; border-radius:8px; overflow:hidden; width:160px; flex-shrink:0; transition:transform 0.2s; box-shadow:0 2px 8px rgba(0,0,0,0.08);";
            w.innerHTML = `<img src="${imgPath}" style="width:100%; height:auto; display:block;" onerror="this.style.height='120px'; this.style.background='#f5f0e8';">
                <div style="padding:4px; font-size:0.6rem; text-align:center; background:#fffbeb; color:#d97706;">
                    ${card.name}<br><span style="font-size:0.5rem; color:#78716c;">${card.cost > 0 ? card.cost + 'W' : 'Free'} | ${card.description || ''}</span>
                </div>`;

            w.onmouseenter = () => { if (preview.style.display === 'none') { w.style.transform = 'scale(1.6)'; w.style.zIndex = '10'; w.style.position = 'relative'; } };
            w.onmouseleave = () => { w.style.transform = 'scale(1)'; w.style.zIndex = ''; w.style.position = ''; };
            w.onclick = () => {
                w.style.transform = 'scale(1)'; w.style.zIndex = ''; w.style.position = '';
                preview.style.display = 'block';
                preview.innerHTML = `
                    <div style="background:#ffffff; border:2px solid #d97706; border-radius:12px; overflow:hidden; width:280px; box-shadow:0 8px 32px rgba(0,0,0,0.18);">
                        <img src="${imgPath}" style="width:100%; height:auto; display:block;" onerror="this.style.display='none'">
                        <div style="padding:6px; font-size:0.7rem; color:#d97706; background:#fffbeb; text-align:center; font-weight:500;">${card.name} - ${card.description || ''}</div>
                        <div style="padding:10px; display:flex; gap:8px; justify-content:center; background:#fffbeb;">
                            <button class="steal-yes" style="padding:8px 20px; background:#d97706; color:#fff; border:none; cursor:pointer; font-weight:bold; font-size:0.8rem; border-radius:8px;">STEAL THIS</button>
                            <button class="steal-no" style="padding:8px 20px; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; cursor:pointer; font-size:0.8rem; border-radius:8px;">BACK</button>
                        </div>
                    </div>`;
                opts.style.opacity = '0.3';
                opts.style.pointerEvents = 'none';
                preview.querySelector('.steal-yes').onclick = () => {
                    preview.remove(); modal.style.display = 'none'; opts.style.cssText = '';
                    resolve({card_id: card.id});
                };
                preview.querySelector('.steal-no').onclick = () => {
                    preview.style.display = 'none';
                    opts.style.opacity = ''; opts.style.pointerEvents = '';
                };
            };
            opts.appendChild(w);
        });

        modal.querySelector(':scope > div').appendChild(preview);
        modal.style.display = "flex";
    });
}

// ── PAY OR LOSE ───────────────────────────────────────────
function promptPayOrLoseModal(interaction) {
    return new Promise(resolve => {
        const modal = document.getElementById('choice-modal');
        const titleEl = document.getElementById('modal-title');
        const descEl = document.getElementById('modal-desc');
        const opts = document.getElementById('modal-options');

        titleEl.innerText = `Patent Troll: ${interaction.target_player_name} must choose`;
        descEl.innerText = `${interaction.card_name} forces a choice:`;
        opts.innerHTML = "";
        opts.style.cssText = "display:flex; flex-direction:column; gap:10px; align-items:center;";

        const payBtn = document.createElement('button');
        payBtn.innerText = `Pay $${interaction.pay_amount}`;
        payBtn.disabled = !interaction.can_pay;
        payBtn.style.cssText = `padding:12px 30px; font-size:0.9rem; font-weight:bold; cursor:${interaction.can_pay ? 'pointer' : 'not-allowed'}; background:${interaction.can_pay ? '#4f46e5' : '#f5f0e8'}; color:${interaction.can_pay ? '#fff' : '#78716c'}; border:${interaction.can_pay ? 'none' : '1px solid #d4c9b8'}; min-width:250px; border-radius:8px;`;
        payBtn.onclick = () => {
            if (!interaction.can_pay) return;
            modal.style.display = 'none'; opts.style.cssText = '';
            resolve({choice: 'pay'});
        };
        opts.appendChild(payBtn);

        const loseBtn = document.createElement('button');
        loseBtn.innerText = interaction.lose_description;
        loseBtn.style.cssText = "padding:12px 30px; font-size:0.9rem; font-weight:bold; cursor:pointer; background:#dc2626; color:#fff; border:none; min-width:250px; border-radius:8px;";
        loseBtn.onclick = () => {
            modal.style.display = 'none'; opts.style.cssText = '';
            resolve({choice: 'lose'});
        };
        opts.appendChild(loseBtn);

        modal.style.display = "flex";
    });
}

// ── SQUEEZE REGION ────────────────────────────────────────
function promptChooseSqueezeRegionModal(interaction) {
    return new Promise(resolve => {
        const modal = document.getElementById('choice-modal');
        const titleEl = document.getElementById('modal-title');
        const descEl = document.getElementById('modal-desc');
        const opts = document.getElementById('modal-options');

        titleEl.innerText = `Squeeze Out: Choose a region to remove ${interaction.target_player_name} from`;
        descEl.innerText = "Select one of the shared regions:";
        opts.innerHTML = "";
        opts.style.cssText = "display:flex; flex-wrap:wrap; justify-content:center; gap:10px;";

        (interaction.shared_regions || []).forEach(regionId => {
            const regionName = REGIONS[regionId - 1] || `Region ${regionId}`;
            const btn = document.createElement('button');
            btn.innerText = `R${regionId}: ${regionName}`;
            btn.style.cssText = "padding:12px 20px; cursor:pointer; background:#eef2ff; color:#4f46e5; border:2px solid #4f46e5; font-weight:bold; font-size:0.85rem; min-width:150px; border-radius:8px;";
            btn.onmouseenter = () => { btn.style.background = '#4f46e5'; btn.style.color = '#fff'; };
            btn.onmouseleave = () => { btn.style.background = '#eef2ff'; btn.style.color = '#4f46e5'; };
            btn.onclick = () => {
                modal.style.display = 'none'; opts.style.cssText = '';
                resolve({region_id: regionId});
            };
            opts.appendChild(btn);
        });

        const cancel = document.createElement('button');
        cancel.innerText = "Cancel";
        cancel.style.cssText = "padding:8px 16px; cursor:pointer; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; width:100%; margin-top:8px; border-radius:8px;";
        cancel.onclick = () => { modal.style.display = 'none'; opts.style.cssText = ''; resolve(null); };
        opts.appendChild(cancel);

        modal.style.display = "flex";
    });
}

// ── CHOOSE REGIONS ────────────────────────────────────────
function promptChooseRegionsModal(interaction) {
    return new Promise(resolve => {
        const modal = document.getElementById('choice-modal');
        const titleEl = document.getElementById('modal-title');
        const descEl = document.getElementById('modal-desc');
        const opts = document.getElementById('modal-options');

        titleEl.innerText = `Celebrity Tour: Choose up to ${interaction.max_regions} regions to expand into`;
        descEl.innerText = `Current presence: ${(interaction.current_presence || []).map(r => REGIONS[r-1] || 'R'+r).join(', ')}`;
        opts.innerHTML = "";
        opts.style.cssText = "display:flex; flex-direction:column; gap:8px; align-items:center;";

        const selected = new Set();
        const checkboxContainer = document.createElement('div');
        checkboxContainer.style.cssText = "display:flex; flex-wrap:wrap; justify-content:center; gap:8px;";

        (interaction.available_regions || []).forEach(regionId => {
            const regionName = REGIONS[regionId - 1] || `Region ${regionId}`;
            const label = document.createElement('label');
            label.style.cssText = "display:flex; align-items:center; gap:6px; padding:10px 14px; background:#ffffff; border:2px solid #4f46e5; border-radius:8px; cursor:pointer; font-size:0.8rem; color:#4f46e5; min-width:140px;";

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = regionId;
            cb.style.cssText = "accent-color:#4f46e5; width:16px; height:16px;";
            cb.onchange = () => {
                if (cb.checked) {
                    if (selected.size >= interaction.max_regions) { cb.checked = false; return; }
                    selected.add(regionId);
                    label.style.background = '#eef2ff';
                } else {
                    selected.delete(regionId);
                    label.style.background = '#ffffff';
                }
                confirmBtn.innerText = `Confirm (${selected.size}/${interaction.max_regions})`;
            };

            label.appendChild(cb);
            label.appendChild(document.createTextNode(`R${regionId}: ${regionName}`));
            checkboxContainer.appendChild(label);
        });
        opts.appendChild(checkboxContainer);

        const confirmBtn = document.createElement('button');
        confirmBtn.innerText = `Confirm (0/${interaction.max_regions})`;
        confirmBtn.style.cssText = "padding:10px 30px; cursor:pointer; background:#4f46e5; color:#fff; border:none; font-weight:bold; font-size:0.85rem; margin-top:8px; border-radius:8px;";
        confirmBtn.onclick = () => {
            if (selected.size === 0) return;
            modal.style.display = 'none'; opts.style.cssText = '';
            resolve({region_ids: Array.from(selected)});
        };
        opts.appendChild(confirmBtn);

        const cancel = document.createElement('button');
        cancel.innerText = "Cancel";
        cancel.style.cssText = "padding:8px 16px; cursor:pointer; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; margin-top:4px; border-radius:8px;";
        cancel.onclick = () => { modal.style.display = 'none'; opts.style.cssText = ''; resolve(null); };
        opts.appendChild(cancel);

        modal.style.display = "flex";
    });
}

// ── DRAWN CARD CHOICE ─────────────────────────────────────
async function handleDrawnCardChoice(playerId, drawnCards) {
    // Show the drawn cards and let the user pick which one to play for free
    return new Promise(async (resolve) => {
        const modal = document.getElementById('choice-modal');
        document.getElementById('modal-title').innerText = "Unethical Data Source";
        document.getElementById('modal-desc').innerText = "You drew 2 Research cards. Choose 1 to play for free:";
        const opts = document.getElementById('modal-options');
        opts.innerHTML = "";
        opts.style.cssText = "display:flex; flex-wrap:wrap; justify-content:center; gap:12px;";

        // Clean up old previews
        modal.querySelectorAll('.card-preview-overlay').forEach(el => el.remove());

        for (const card of drawnCards) {
            const img = card.image_file ? `assets/${card.image_file}` : '';
            const w = document.createElement('div');
            w.style.cssText = "width:180px; flex-shrink:0; border-radius:8px; overflow:hidden; border:2px solid #4f46e5; cursor:pointer; transition:transform 0.2s; box-shadow:0 2px 8px rgba(0,0,0,0.08);";
            w.onmouseenter = () => { w.style.transform = 'scale(1.1)'; };
            w.onmouseleave = () => { w.style.transform = 'scale(1)'; };
            w.innerHTML = `<img src="${img}" style="width:100%; height:auto; display:block;" onerror="this.style.height='120px'; this.style.background='#f5f0e8';">
                <div style="padding:4px; font-size:0.65rem; text-align:center; background:#eef2ff; color:#4f46e5; font-weight:600;">PLAY THIS CARD</div>`;
            w.onclick = async () => {
                modal.style.display = 'none';
                opts.style.cssText = '';
                const otherCard = drawnCards.find(c => c.id !== card.id);
                const payload = {chosen_card_id: card.id};
                if (otherCard) payload.other_card_id = otherCard.id;
                const result = CardEffects.unethical_data(Game.localState, playerId, 0, payload);
                if (result.error) { addLog(`ERR: ${result.error}`); }
                else { addLog(`Played ${card.name} for free!`); }
                refreshData();
                resolve();
            };
            opts.appendChild(w);
        }

        modal.style.display = "flex";
    });
}

// ── PENDING INTERACTIONS ──────────────────────────────────
// processPendingInteractions is defined in app.js (uses resolveInteraction from app.js)
