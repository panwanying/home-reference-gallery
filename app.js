'use strict';

(() => {
  const CATEGORIES = ['材质与肌理','色彩搭配','造型与线条','灯光与氛围','家具与软装','空间与部位'];
  const LABELS = {unmarked:'未标记',liked:'喜欢',considering:'待考虑',disliked:'不喜欢'};
  const VIEWS = ['gallery','categories','preferences','pending'];
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const canonical = clone(window.REFERENCE_DATA);
  const draftKey = `reference-draft:${canonical.collectionId}`;
  const params = new URLSearchParams(location.search);
  const state = {
    data: clone(canonical), dirty: false, view: VIEWS.includes(params.get('view')) ? params.get('view') : 'gallery',
    readOnly: params.get('mode') === 'view', search:'', space:'all', category:'all', preference:'all', favorite:false,
    selected: params.get('image'), zoom:false, openNotes:new Set(), noteDrafts:new Map(), assetFiles:new Map(), assetUrls:new Map(),
    importData:null, editing:null, toastTimer:null,
  };

  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 5200);
  }

  function assetDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('home-reference-assets', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function storeAsset(path, file) {
    const db = await assetDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files','readwrite');
      tx.objectStore('files').put(file, `${canonical.collectionId}:${path}`);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('图片草稿保存失败'));
    });
    db.close();
  }
  async function readAsset(path) {
    const db = await assetDatabase();
    const file = await new Promise((resolve,reject) => {
      const req = db.transaction('files').objectStore('files').get(`${canonical.collectionId}:${path}`);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return file;
  }

  function validateDataset(data) {
    if (!data || data.schemaVersion !== 1 || data.collectionId !== canonical.collectionId || !Array.isArray(data.images)) {
      throw new Error('这不是当前参考图库的有效更新文件');
    }
    if (data.images.length > 2000) throw new Error('单个图库最多导入2000张图片');
    const imageIds = new Set();
    for (const image of data.images) {
      if (!image || typeof image.id !== 'string' || imageIds.has(image.id)) throw new Error('图片编号缺失或重复');
      imageIds.add(image.id);
      for (const key of ['filename','title','space','summary','imageUrl']) {
        if (typeof image[key] !== 'string' || image[key].length > 10000) throw new Error('图片资料格式不正确');
      }
      if (!/^assets\/[^/\\?#]+\.(jpe?g|png|webp|gif)$/i.test(image.imageUrl)) throw new Error('图片路径必须位于 assets 文件夹');
      if (!Array.isArray(image.elements) || image.elements.length > 100) throw new Error('元素数量或格式不正确');
      const elementIds = new Set();
      for (const element of image.elements) {
        if (typeof element.id !== 'string' || elementIds.has(element.id)) throw new Error('元素编号缺失或重复');
        elementIds.add(element.id);
        if (!CATEGORIES.includes(element.category) || !Object.hasOwn(LABELS,element.preference)) throw new Error('元素分类或偏好状态不正确');
        for (const key of ['name','location','description','certainty','priority','note','targetSpace']) {
          if (typeof element[key] !== 'string' || element[key].length > 10000) throw new Error('元素资料格式不正确');
        }
      }
      for (const key of ['styleHints','palette','keywords','questions']) {
        if (!Array.isArray(image[key]) || image[key].length > 100 || image[key].some((v) => typeof v !== 'string')) throw new Error('图片标签格式不正确');
      }
      image.personalNote = String(image.personalNote || '').slice(0,10000);
      image.imageNote = String(image.imageNote || '').slice(0,10000);
      image.favorite = image.favorite === true;
      image.analysisStatus = image.analysisStatus === 'pending' ? 'pending' : 'analyzed';
    }
    return data;
  }

  function saveDraft(message) {
    state.dirty = true;
    try {
      localStorage.setItem(draftKey, JSON.stringify({baseRevision:canonical.revision, data:state.data}));
    } catch {
      toast('浏览器无法保存本机草稿，请立即导出更新包，以免关闭后丢失。');
      render();
      return;
    }
    render();
    if (message) toast(message);
  }
  function getImage(id) { return state.data.images.find((image) => image.id === id); }
  function source(image) {
    return state.assetUrls.get(image.imageUrl) || window.REFERENCE_ASSETS?.[image.imageUrl] || image.imageUrl;
  }
  function getElement(imageId,elementId) { return getImage(imageId)?.elements.find((element) => element.id === elementId); }
  function updateAddress() {
    const url = new URL(location.href);
    for (const key of ['view','image','mode']) url.searchParams.delete(key);
    if (state.view !== 'gallery') url.searchParams.set('view',state.view);
    if (state.selected) url.searchParams.set('image',state.selected);
    if (state.readOnly) url.searchParams.set('mode','view');
    history.replaceState(null,'',url);
  }
  function imageSearchMatch(image) {
    return [image.filename,image.title,image.space,image.summary,image.personalNote,...image.palette,...image.styleHints]
      .join(' ').toLowerCase().includes(state.search.toLowerCase());
  }
  function matchedElements(image) {
    return image.elements.filter((element) => {
      if (state.category !== 'all' && element.category !== state.category) return false;
      if (state.preference !== 'all' && element.preference !== state.preference) return false;
      if (state.view === 'preferences' && element.preference === 'unmarked') return false;
      if (state.search && !imageSearchMatch(image)) {
        return [element.name,element.location,element.description,element.note,element.targetSpace,element.category]
          .join(' ').toLowerCase().includes(state.search.toLowerCase());
      }
      return true;
    });
  }
  function matchedImages() {
    return state.data.images.filter((image) => {
      if (state.space !== 'all' && image.space !== state.space) return false;
      if (state.favorite && !image.favorite) return false;
      if (state.view === 'pending' && image.analysisStatus !== 'pending') return false;
      const elements = matchedElements(image);
      if (state.view === 'preferences' || state.category !== 'all' || state.preference !== 'all') return elements.length > 0;
      if (state.search && !imageSearchMatch(image) && !elements.length) return false;
      return true;
    });
  }
  function empty(title,description,action='reset-filters',label='清除筛选') {
    return `<div class="empty"><h2>${escape(title)}</h2><p>${escape(description)}</p><button class="button outline" data-action="${action}">${label}</button></div>`;
  }
  function preferenceButtons(image,element) {
    if (state.readOnly) return `<span class="group-badge pref-${element.preference}">${LABELS[element.preference]}</span>`;
    return `<div class="pref-actions" role="group" aria-label="${escape(element.name)}的偏好">${['liked','considering','disliked'].map((pref) =>
      `<button class="pref-button ${pref}" aria-pressed="${element.preference === pref}" data-action="preference" data-image="${escape(image.id)}" data-element="${escape(element.id)}" data-preference="${pref}">${LABELS[pref]}</button>`).join('')}
      <button class="pref-button clear" data-action="preference" data-image="${escape(image.id)}" data-element="${escape(element.id)}" data-preference="unmarked" aria-label="清除${escape(element.name)}的偏好">清除</button></div>`;
  }
  function card(image) {
    const liked = image.elements.filter((element) => element.preference === 'liked').length;
    const tags = [...new Set(image.elements.map((element) => element.name))].slice(0,3);
    return `<article class="image-card"><div class="photo-wrap">
      <button class="photo-button" data-action="detail" data-image="${escape(image.id)}" aria-label="查看${escape(image.filename)}的分析"><img src="${escape(source(image))}" alt="${escape(image.title)}，原文件${escape(image.filename)}" loading="lazy"></button>
      <div class="image-loading"><span>正在读取图片…</span></div>
      <span class="space-label">${escape(image.space)}</span>
      ${state.readOnly ? '' : `<button class="favorite-button ${image.favorite ? 'selected' : ''}" aria-pressed="${image.favorite}" data-action="favorite" data-image="${escape(image.id)}" aria-label="${image.favorite ? '取消收藏' : '收藏'}${escape(image.filename)}">${image.favorite ? '★' : '☆'}</button>`}
      </div><div class="card-body"><p class="filename">${escape(image.filename)}</p>
      <button class="card-title" data-action="detail" data-image="${escape(image.id)}">${escape(image.title)}</button>
      <div class="tags">${tags.map((tag) => `<span class="tag">${escape(tag)}</span>`).join('') || '<span class="tag">等待补充分析</span>'}</div>
      <div class="card-bottom"><span>${image.analysisStatus === 'pending' ? '待分析' : `${image.elements.length} 个设计元素`}</span><span class="${liked ? 'like-text' : ''}">${liked ? `${liked} 个喜欢` : '尚未选择偏好'}</span></div></div></article>`;
  }
  function elementPreview(image,element) {
    return `<article class="element-preview"><button class="mini-image" data-action="detail" data-image="${escape(image.id)}" aria-label="查看${escape(image.filename)}"><img src="${escape(source(image))}" alt="${escape(image.title)}" loading="lazy"></button>
      <div><p class="filename">${escape(image.filename)}</p><h3>${escape(element.name)}</h3><p class="location">${escape(element.location)}</p><p>${escape(element.description)}</p>
      ${element.note || element.targetSpace ? `<div class="element-note">${element.targetSpace ? `<span>考虑用于：</span>${escape(element.targetSpace)}<br>` : ''}${escape(element.note)}</div>` : ''}
      ${preferenceButtons(image,element)}<button class="button quiet small" data-action="detail" data-image="${escape(image.id)}">查看原图与备注 ↗</button></div></article>`;
  }
  function render() {
    document.body.classList.toggle('view-only',state.readOnly);
    $('mode-button').textContent = state.readOnly ? '编辑本机草稿' : '切换为查看模式';
    const allElements = state.data.images.flatMap((image) => image.elements);
    $('count-images').textContent = state.data.images.length;
    $('count-elements').textContent = allElements.length;
    $('count-liked').textContent = allElements.filter((element) => element.preference === 'liked').length;
    $('count-pending').textContent = state.data.images.filter((image) => image.analysisStatus === 'pending').length;
    $('draft-status').textContent = state.dirty ? '有待上传的本机草稿' : '已上传版本';
    $('draft-status').classList.toggle('dirty',state.dirty);
    $('version-label').textContent = `${state.data.images.length} 张参考 · ${allElements.length} 个元素`;
    document.querySelectorAll('[data-action="view"]').forEach((button) => {
      button.classList.toggle('active',button.dataset.view === state.view);
      if (button.dataset.view === state.view) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
    });
    const heading = {
      gallery:['从图片里，找到喜欢的细节。','先看整体，再分别选择材质、配色、造型和灯光。'],
      categories:['把同一类元素，放在一起看。','同一张图可以属于多个类别；点击缩略图回到完整分析。'],
      preferences:['留给设计师的，是具体的偏好。','只汇总你标记过的元素，并保留原图、位置与个人备注。'],
      pending:['新的灵感，先放在这里。','新增图片默认待分析；你可以手动补充，也可以后续交给我继续分析。'],
    }[state.view];
    $('page-title').textContent = heading[0]; $('page-description').textContent = heading[1];
    $('view-notice').hidden = !state.readOnly;
    $('view-notice').textContent = '当前为查看模式。链接展示已上传版本；切换到编辑模式只会修改当前浏览器的草稿。';
    const images = matchedImages();
    if (state.view === 'gallery' || state.view === 'pending') {
      $('result-count').textContent = `显示 ${images.length} / ${state.data.images.length} 张参考图`;
      $('content').innerHTML = images.length ? `<div class="gallery">${images.map(card).join('')}</div>` :
        (state.view === 'pending' && !state.data.images.some((image) => image.analysisStatus === 'pending') ?
        empty('首批 4 张已完成分析','添加新图片后，会在这里等待补充分析。',state.readOnly ? 'view-gallery' : 'upload',state.readOnly ? '查看全部参考' : '添加参考图') :
        empty('没有符合条件的图片','试试减少筛选条件，或换个关键词。'));
    } else {
      const rows = images.flatMap((image) => matchedElements(image).map((element) => ({image,element})));
      $('result-count').textContent = `显示 ${rows.length} 个元素 · 来自 ${images.length} 张参考图`;
      const intro = state.view === 'preferences' ? `<div class="preference-intro"><strong>喜欢 ${allElements.filter((e) => e.preference === 'liked').length}</strong>　待考虑 ${allElements.filter((e) => e.preference === 'considering').length}　不喜欢 ${allElements.filter((e) => e.preference === 'disliked').length}<br><span class="field-help">图片中出现的其他元素，仍保持未标记；收藏图片与选择元素分别记录。</span></div>` : '';
      $('content').innerHTML = intro + (rows.length ? CATEGORIES.map((category) => {
        const group = rows.filter((row) => row.element.category === category);
        if (!group.length) return '';
        return `<section class="category-section"><div class="category-heading"><h2>${category}</h2><span>${group.length} 个参考</span></div><div class="element-grid">${group.map(({image,element}) => elementPreview(image,element)).join('')}</div></section>`;
      }).join('') : state.view === 'preferences' ? empty('先选几个你喜欢的细节','打开一张参考图，分别标记里面的材质、配色或灯具。','view-gallery','去看参考图') : empty('没有符合条件的元素','试试减少筛选条件。'));
    }
    if ($('detail-dialog').open && state.selected) renderDetail();
    document.querySelectorAll('.photo-button img').forEach((image) => {
      if(image.complete && image.naturalWidth>0) image.closest('.photo-wrap').classList.add('image-ready');
    });
  }

  function refreshFilterOptions() {
    $('space-filter').innerHTML = '<option value="all">全部空间</option>' + [...new Set(state.data.images.map((image) => image.space))].map((space) => `<option value="${escape(space)}">${escape(space)}</option>`).join('');
    if (![...$('space-filter').options].some((option) => option.value === state.space)) state.space = 'all';
    $('space-filter').value = state.space;
    $('category-filter').innerHTML = '<option value="all">全部元素</option>' + CATEGORIES.map((category) => `<option value="${category}">${category}</option>`).join('');
    $('category-filter').value = state.category;
    $('preference-filter').value = state.preference;
    $('favorite-filter').checked = state.favorite;
    $('search').value = state.search;
  }

  function noteEditor(image,element) {
    if (!state.openNotes.has(element.id) || state.readOnly) return '';
    const draft=state.noteDrafts.get(`${image.id}:${element.id}`) || element;
    return `<div class="note-editor"><label class="field">想用在家里的哪里？<input data-note-space="${escape(element.id)}" value="${escape(draft.targetSpace)}" maxlength="500" placeholder="例如：书房柜体，客厅局部"></label>
      <label class="field">喜欢或不喜欢的具体原因<textarea data-note-text="${escape(element.id)}" maxlength="6000" placeholder="例如：喜欢木色，但不喜欢格栅造型">${escape(draft.note)}</textarea></label>
      <button class="button outline small" data-action="save-note" data-image="${escape(image.id)}" data-element="${escape(element.id)}">保存到本机草稿</button></div>`;
  }
  function renderDetail() {
    const image = getImage(state.selected);
    if (!image) return closeDetail();
    const dialog = $('detail-dialog');
    const previousScroll = dialog.querySelector('.detail-panel')?.scrollTop || 0;
    const previousMobileScroll = dialog.querySelector('.detail-layout')?.scrollTop || 0;
    const activeImageIds = matchedImages().map((item) => item.id);
    const index = activeImageIds.indexOf(image.id);
    dialog.innerHTML = `<header class="detail-header"><div><h2 id="detail-title">${escape(image.filename)}</h2><small>${escape(image.space)} · ${image.elements.length} 个设计元素</small></div>
      <div class="header-buttons"><button class="button quiet small" data-action="previous" ${index <= 0 ? 'disabled' : ''}>← 上一张</button><button class="button quiet small" data-action="next" ${index < 0 || index >= activeImageIds.length-1 ? 'disabled' : ''}>下一张 →</button><button class="close-button" data-action="close-detail" aria-label="关闭图片分析">×</button></div></header>
      <div class="detail-layout"><div class="detail-photo"><button class="image-stage ${state.zoom ? 'zoomed' : ''}" data-action="zoom" aria-label="${state.zoom ? '缩小图片' : '放大图片'}"><img src="${escape(source(image))}" alt="${escape(image.title)}，${escape(image.filename)}"></button>
      <div class="photo-footer"><span>点击图片放大 / 缩小</span><a href="${escape(source(image))}" target="_blank" rel="noopener" download="${escape(image.filename)}">查看 / 下载原图 ↗</a></div></div>
      <section class="detail-panel"><h3>${escape(image.title)}</h3><p class="summary">${escape(image.summary)}</p>
      <div class="palette-list">${image.palette.map((color) => `<span class="palette-chip">${escape(color)}</span>`).join('')}</div>
      <p class="photo-note">风格搜索辅助：${image.styleHints.map(escape).join('、') || '待补充'}；风格名称不等于你的偏好。</p>
      <div class="detail-section-heading"><h4>逐个选择你在意的元素</h4>${state.readOnly ? '' : `<button class="button quiet small" data-action="edit-image" data-image="${escape(image.id)}">编辑整图说明</button>`}</div>
      <p class="explain">所有元素默认未标记。每一项的选择和备注分别保存。</p>
      ${image.elements.map((element,index) => `<article class="element-block" data-pref="${element.preference}" id="element-${escape(element.id)}"><div class="element-top"><div><p class="element-category">${escape(element.category)} · ${escape(element.priority)}</p><h4>${escape(element.name)}</h4></div><span class="element-index">${String(index+1).padStart(2,'0')}</span></div>
      <p class="element-location">位置：${escape(element.location)}</p><p class="element-description">${escape(element.description)}</p>${element.certainty !== '明确' ? `<p class="certainty">${escape(element.certainty)}</p>` : ''}
      ${preferenceButtons(image,element)}
      ${element.note || element.targetSpace ? `<div class="element-note">${element.targetSpace ? `<span>考虑用于：</span>${escape(element.targetSpace)}<br>` : ''}${escape(element.note)}</div>` : ''}
      ${state.readOnly ? '' : `<button class="button quiet small" data-action="toggle-note" data-element="${escape(element.id)}">${state.openNotes.has(element.id) ? '收起备注' : '写备注 / 使用位置'}</button><button class="button quiet small" data-action="edit-element" data-image="${escape(image.id)}" data-element="${escape(element.id)}">修改分析</button>`}
      ${noteEditor(image,element)}</article>`).join('') || '<p class="summary">这张图还没有元素分析。可以手动添加，或后续继续分析。</p>'}
      ${state.readOnly ? '' : `<button class="button outline full" data-action="add-element" data-image="${escape(image.id)}">＋ 补充一个设计元素</button>`}
      ${image.keywords.length ? `<div class="detail-section-heading"><h4>继续找图的关键词</h4></div><div class="detail-keywords">${image.keywords.map((word) => `<span>${escape(word)}</span>`).join('')}</div>` : ''}
      ${image.questions.length ? `<div class="detail-section-heading"><h4>与设计师讨论</h4></div><ul class="question-list">${image.questions.map((q) => `<li>${escape(q)}</li>`).join('')}</ul>` : ''}
      <div class="detail-section-heading"><h4>这张图的整体备注</h4></div>${state.readOnly ? `<p class="summary">${escape(image.personalNote) || '尚无整体备注'}</p>` : `<label class="sr-only" for="personal-note">这张图的整体备注</label><textarea id="personal-note" class="personal-note" maxlength="6000" placeholder="例如：喜欢整体配色，只想参考床头和窗帘。">${escape(image.personalNote)}</textarea><button class="button outline small" data-action="save-personal" data-image="${escape(image.id)}">保存整体备注</button>`}
      ${image.imageNote ? `<p class="photo-note">图片说明：${escape(image.imageNote)}</p>` : ''}
      </section></div>`;
    dialog.querySelector('.detail-panel').scrollTop = previousScroll;
    dialog.querySelector('.detail-layout').scrollTop = previousMobileScroll;
  }
  function openDetail(id) {
    if (!getImage(id)) return;
    state.selected=id; state.zoom=false; state.openNotes.clear();
    renderDetail();
    if (!$('detail-dialog').open) $('detail-dialog').showModal();
    updateAddress();
  }
  function closeDetail() {
    $('detail-dialog').close(); state.selected=null; state.zoom=false; updateAddress();
  }
  function utility(title,body) {
    $('utility-dialog').innerHTML = `<header class="small-dialog-header"><h2 id="utility-title">${escape(title)}</h2><button class="close-button" data-action="close-utility" aria-label="关闭">×</button></header><div class="small-dialog-body">${body}</div>`;
    if (!$('utility-dialog').open) $('utility-dialog').showModal();
  }
  function editor(imageId,elementId,adding=false) {
    if (state.readOnly) return;
    const image=getImage(imageId); if (!image) return;
    const element=elementId ? getElement(imageId,elementId) : null;
    state.editing={imageId,elementId,adding};
    const field=(label,name,value,area=false) => `<label class="field">${label}${area ? `<textarea name="${name}" maxlength="6000">${escape(value)}</textarea>` : `<input name="${name}" value="${escape(value)}" maxlength="200" ${['title','space','name'].includes(name) ? 'required' : ''}>`}</label>`;
    const isElement=adding || element;
    const contents=isElement ?
      field('元素名称','name',element?.name || '') + `<div class="field-grid"><label class="field">分类<select name="category">${CATEGORIES.map((category) => `<option ${element?.category === category ? 'selected' : ''}>${category}</option>`).join('')}</select></label><label class="field">主次<select name="priority"><option ${element?.priority !== '次要' ? 'selected' : ''}>主要</option><option ${element?.priority === '次要' ? 'selected' : ''}>次要</option></select></label></div>` +
      field('位于图片中的哪里','location',element?.location || '') + field('具体表现','description',element?.description || '',true) + field('确定程度','certainty',element?.certainty || '待确认') :
      field('图片标题','title',image.title) + field('空间','space',image.space) + field('整体说明','summary',image.summary,true) +
      field('色彩（每行一个）','palette',image.palette.join('\n'),true) + field('风格搜索辅助（每行一个）','styleHints',image.styleHints.join('\n'),true) +
      field('找图关键词（每行一个）','keywords',image.keywords.join('\n'),true) + field('和设计师讨论的问题（每行一个）','questions',image.questions.join('\n'),true) +
      field('图片说明 / 材质判断限制','imageNote',image.imageNote,true) + `<label class="field">分析状态<select name="analysisStatus"><option value="analyzed" ${image.analysisStatus === 'analyzed' ? 'selected' : ''}>已分析</option><option value="pending" ${image.analysisStatus === 'pending' ? 'selected' : ''}>待分析</option></select></label>`;
    $('edit-dialog').innerHTML=`<header class="small-dialog-header"><h2 id="edit-title">${isElement ? (adding ? '补充设计元素' : '修改元素分析') : '编辑整图说明'}</h2><button class="close-button" data-action="close-editor" aria-label="关闭编辑">×</button></header><form id="edit-form" class="small-dialog-body"><p class="filename">${escape(image.filename)}</p>${contents}<p class="field-help">保存到当前浏览器草稿；导出并上传 Git 后，其他人才能看到修改。</p><div class="dialog-actions"><button type="button" class="button quiet" data-action="close-editor">取消</button><button type="submit" class="button primary">保存修改</button></div></form>`;
    $('edit-dialog').showModal();
  }
  function saveEditor(form) {
    if (!state.editing || !form.reportValidity()) return;
    const fields=new FormData(form); const image=getImage(state.editing.imageId);
    const read=(name) => String(fields.get(name) || '').trim();
    if (state.editing.adding || state.editing.elementId) {
      const values={name:read('name'),category:read('category'),priority:read('priority'),location:read('location'),description:read('description'),certainty:read('certainty')};
      if (state.editing.adding) image.elements.push({...values,id:`el-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,preference:'unmarked',note:'',targetSpace:''});
      else Object.assign(getElement(image.id,state.editing.elementId),values);
    } else {
      for (const name of ['title','space','summary','imageNote','analysisStatus']) image[name]=read(name);
      for (const name of ['palette','styleHints','keywords','questions']) image[name]=read(name).split('\n').map((s) => s.trim()).filter(Boolean);
    }
    $('edit-dialog').close(); refreshFilterOptions(); saveDraft('修改已保存到本机草稿。');
  }

  function download(blob,filename) {
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url),30000);
  }
  function exportedData() {
    const data=clone(state.data); data.revision=`update-${Date.now()}`;
    for (const image of data.images) delete image._pendingAsset;
    return data;
  }
  function dataScript(data) { return `window.REFERENCE_DATA = ${JSON.stringify(data,null,2)};\n`; }

  // A dependency-free ZIP writer: STORE entries, UTF-8 names, CRC32 checksums.
  // Update archives contain data.js and only newly added image files.
  const CRC_TABLE=Array.from({length:256},(_,n) => {let c=n;for(let k=0;k<8;k++) c=(c&1) ? 0xedb88320^(c>>>1) : c>>>1;return c>>>0;});
  function crc32(bytes) {let crc=0xffffffff;for(const byte of bytes) crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
  function header(length) {const bytes=new Uint8Array(length);return {bytes,view:new DataView(bytes.buffer)};}
  async function zip(entries) {
    const encoder=new TextEncoder(); const chunks=[]; const central=[]; let offset=0;
    for (const entry of entries) {
      const name=encoder.encode(entry.name); const bytes=entry.content instanceof Uint8Array ? entry.content : new Uint8Array(await new Blob([entry.content]).arrayBuffer());
      const crc=crc32(bytes); const local=header(30); const l=local.view;
      l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(12,0x21,true);l.setUint32(14,crc,true);l.setUint32(18,bytes.length,true);l.setUint32(22,bytes.length,true);l.setUint16(26,name.length,true);
      chunks.push(local.bytes,name,bytes); const item=header(46);const c=item.view;
      c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,0x21,true);c.setUint32(16,crc,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);
      central.push(item.bytes,name);offset+=30+name.length+bytes.length;
    }
    const centralLength=central.reduce((sum,chunk) => sum+chunk.length,0); const end=header(22);const v=end.view;
    v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,centralLength,true);v.setUint32(16,offset,true);
    return new Blob([...chunks,...central,end.bytes],{type:'application/zip'});
  }
  function showExport() {
    const pending=state.data.images.filter((image) => image._pendingAsset).length;
    utility('导出更新，上传到 Git',`<p>这里的标记和备注先保存在本机。把导出文件上传至仓库，网页更新后，其他电脑和设计师才能看到。</p>
      <button class="export-option" data-action="export-data" ${pending ? 'disabled' : ''}><strong>只导出更新文件 · data.js</strong><span>${pending ? `有 ${pending} 张新图片，请使用下面的更新包` : '适合只修改偏好、备注或分析；上传到仓库根目录替换同名文件。'}</span></button>
      <button class="export-option" data-action="export-zip"><strong>导出更新包 · ZIP</strong><span>包含 data.js${pending ? ` 和 ${pending} 张新增图片` : '，本次没有新增图片'}。解压后按原目录上传，保留已有文件。</span></button>
      <button class="export-option" data-action="export-json"><strong>另存一份资料备份 · JSON</strong><span>可在其他电脑导入标记；不包含图片本身。</span></button><p class="field-help" style="margin-top:18px">下载成功不等于已经上传。网页显示“本机草稿”时，线上版本尚未改变。</p>`);
  }
  async function exportZip() {
    const entries=[{name:'data.js',content:dataScript(exportedData())}];
    for (const image of state.data.images.filter((item) => item._pendingAsset)) {
      const file=state.assetFiles.get(image.imageUrl) || await readAsset(image.imageUrl);
      if (!file) throw new Error(`${image.filename}的新图片文件不在本机，请重新添加图片后导出。`);
      entries.push({name:image.imageUrl,content:new Uint8Array(await file.arrayBuffer())});
    }
    entries.push({name:'上传说明.txt',content:'请将本压缩包解压，把 data.js 上传到 Git 仓库根目录并替换同名文件。若包含 assets 文件夹，请将其中的新图片上传到仓库同名文件夹。保留原来的 index.html、styles.css、app.js 和已有图片。等待 Pages 部署完成后刷新网页。'});
    download(await zip(entries),'装修参考册-更新包.zip'); toast('更新包已导出。解压上传到 Git 后，其他人才能看到。');
  }

  async function addImages(files) {
    if (state.readOnly) return;
    let added=0; const errors=[];
    for (const file of files) {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type) || !/\.(jpe?g|png|webp|gif)$/i.test(file.name)) {errors.push(`${file.name}：请选择常见图片格式`);continue;}
      if (file.size>20*1024*1024) {errors.push(`${file.name}：单张请控制在20MB以内`);continue;}
      const ext=file.name.split('.').pop().toLowerCase(); const id=`ref-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;const path=`assets/${id}.${ext}`;
      try {
        await storeAsset(path,file); state.assetFiles.set(path,file);state.assetUrls.set(path,URL.createObjectURL(file));
        state.data.images.push({id,filename:file.name,imageUrl:path,title:file.name,space:'待分类',summary:'新添加的参考图，等待补充分析。',styleHints:[],palette:[],elements:[],keywords:[],questions:[],imageNote:'',personalNote:'',favorite:false,analysisStatus:'pending',_pendingAsset:true}); added++;
      } catch {errors.push(`${file.name}：浏览器无法保存图片草稿，请检查存储权限`);}
    }
    if (added) {state.view='pending';resetFilters(false);refreshFilterOptions();saveDraft();updateAddress();}
    toast(`${added ? `已添加 ${added} 张，暂存于本机；请导出更新包上传 Git。` : ''}${errors.length ? ' '+errors.join('；') : ''}` || '没有选择图片');
  }
  async function importData(file) {
    if (file.size>15*1024*1024) throw new Error('资料文件超过15MB，请检查是否选错文件');
    let text=await file.text();text=text.replace(/^\uFEFF/,'').trim();
    if (text.startsWith('window.REFERENCE_DATA')) text=text.replace(/^window\.REFERENCE_DATA\s*=\s*/,'').replace(/;\s*$/,'');
    const incoming=validateDataset(JSON.parse(text));state.importData=incoming;
    utility('确认导入资料',`<p>将导入 ${incoming.images.length} 张图片的分析与标记，替换当前浏览器的资料草稿。原 Git 仓库不会自动改变。</p><p>如果文件包含新的图片路径，还需要把对应的 assets 图片文件上传到仓库。</p><div class="dialog-actions"><button class="button quiet" data-action="close-utility">取消</button><button class="button primary" data-action="confirm-import">导入并保存为本机草稿</button></div>`);
  }
  function resetFilters(redraw=true) {
    state.search='';state.space='all';state.category='all';state.preference='all';state.favorite=false;
    refreshFilterOptions();if(redraw)render();
  }
  function printChecklist() {
    document.querySelector('.print-sheet')?.remove();
    const sheet=document.createElement('section');sheet.className='print-sheet';
    const rows=state.data.images.flatMap((image) => image.elements.filter((element) => element.preference !== 'unmarked').map((element) => ({image,element})));
    sheet.innerHTML=`<h1>家的参考册 · 设计师沟通清单</h1><p>生成日期：${new Date().toLocaleDateString('zh-CN')}　${state.dirty ? '包含当前本机草稿' : '已上传版本'}。仅列出已标记的元素；未标记不等于不喜欢。</p>`+
      (rows.length ? CATEGORIES.map((category) => {const group=rows.filter((row) => row.element.category===category);return group.length ? `<h2>${category}</h2>${group.map(({image,element}) => `<article class="print-item"><img src="${escape(source(image))}" alt="${escape(image.filename)}"><div><h3>${escape(element.name)} <span class="pref-status">· ${LABELS[element.preference]}</span></h3><p>参考文件：${escape(image.filename)}｜位置：${escape(element.location)}</p><p>${escape(element.description)}</p>${element.targetSpace ? `<p>考虑用于：${escape(element.targetSpace)}</p>` : ''}${element.note ? `<p>我的备注：${escape(element.note)}</p>` : ''}<p>设计师意见：________________________________________________</p></div></article>`).join('')}` : '';}).join('') : '<p>尚未标记偏好。请先在图片分析中选择喜欢、待考虑或不喜欢的元素。</p>');
    document.body.append(sheet);setTimeout(() => window.print(),150);
  }

  async function handleAction(button) {
    const action=button.dataset.action;const imageId=button.dataset.image;const elementId=button.dataset.element;
    if (['preference','favorite','edit-image','edit-element','add-element','save-note','save-personal','upload','import'].includes(action) && state.readOnly) return;
    switch(action) {
      case 'view':state.view=button.dataset.view;updateAddress();render();break;
      case 'view-gallery':state.view='gallery';resetFilters();updateAddress();break;
      case 'detail':openDetail(imageId);break;
      case 'close-detail':closeDetail();break;
      case 'previous':case 'next':{const images=matchedImages();const index=images.findIndex((image) => image.id===state.selected);const next=images[index+(action==='next'?1:-1)];if(next)openDetail(next.id);break;}
      case 'zoom':state.zoom=!state.zoom;renderDetail();break;
      case 'retry-image':{
        const image=getImage(imageId);if(!image)return;
        const wrap=button.closest('.photo-wrap');const element=wrap.querySelector('img');
        wrap.classList.remove('image-failed','image-ready');
        wrap.querySelector('.image-loading').innerHTML='<span>正在重新读取图片…</span>';
        const url=source(image);element.src=url.startsWith('data:')?url:`${url}${url.includes('?')?'&':'?'}retry=${Date.now()}`;
        break;
      }
      case 'favorite':{const image=getImage(imageId);image.favorite=!image.favorite;saveDraft(image.favorite?'已收藏图片；其中的元素仍需分别选择。':'已取消图片收藏。');break;}
      case 'preference':{const element=getElement(imageId,elementId);if(!element || !Object.hasOwn(LABELS,button.dataset.preference))return;element.preference=element.preference===button.dataset.preference?'unmarked':button.dataset.preference;saveDraft();break;}
      case 'toggle-note':if(state.openNotes.has(elementId))state.openNotes.delete(elementId);else state.openNotes.add(elementId);renderDetail();break;
      case 'save-note':{const element=getElement(imageId,elementId);element.note=document.querySelector(`[data-note-text="${CSS.escape(elementId)}"]`).value.trim();element.targetSpace=document.querySelector(`[data-note-space="${CSS.escape(elementId)}"]`).value.trim();state.noteDrafts.delete(`${imageId}:${elementId}`);saveDraft('备注已保存到本机草稿。');break;}
      case 'save-personal':getImage(imageId).personalNote=$('personal-note').value.trim();saveDraft('整体备注已保存到本机草稿。');break;
      case 'edit-image':editor(imageId);break;
      case 'edit-element':editor(imageId,elementId);break;
      case 'add-element':editor(imageId,null,true);break;
      case 'close-editor':$('edit-dialog').close();break;
      case 'close-utility':$('utility-dialog').close();break;
      case 'reset-filters':resetFilters();break;
      case 'upload':$('image-input').click();break;
      case 'import':$('data-input').click();break;
      case 'confirm-import':state.data=state.importData;state.importData=null;state.selected=null;$('detail-dialog').close();$('utility-dialog').close();refreshFilterOptions();saveDraft('资料已导入本机；图片需要另行上传。');updateAddress();break;
      case 'export':showExport();break;
      case 'export-data':if(state.data.images.some((image) => image._pendingAsset))return;download(new Blob([dataScript(exportedData())],{type:'text/javascript;charset=utf-8'}),'data.js');toast('data.js 已导出。请上传到仓库根目录替换同名文件。');break;
      case 'export-json':download(new Blob([JSON.stringify(exportedData(),null,2)],{type:'application/json'}),'装修参考册-资料备份.json');toast('资料备份已导出；此文件不包含图片。');break;
      case 'export-zip':await exportZip();break;
      case 'toggle-mode':state.readOnly=!state.readOnly;updateAddress();render();break;
      case 'print':printChecklist();break;
      case 'share':{
        if(location.protocol==='file:'){utility('先发布，再分享',`<p>你现在打开的是本地文件，其他人无法访问这个地址。请先将完整网站上传到 GitHub，启用 Pages，再从线上页面复制链接。</p>`);break;}
        const url=new URL(location.href);url.searchParams.set('mode','view');
        try{await navigator.clipboard.writeText(url.href);toast(state.dirty?'链接已复制；本机草稿需上传后，别人才能看到。':'查看链接已复制，可以发给设计师。');}
        catch{utility('复制查看链接',`<label class="field">选中并复制下面的地址<input readonly value="${escape(url.href)}"></label><p>链接展示 Git 上的版本，不包含尚未上传的本机草稿。</p>`);}break;
      }
      case 'help':utility('如何维护这份参考册',`<h3>看图和选元素</h3><p>点开图片，分别标记喜欢、待考虑或不喜欢。收藏只表示方便回看，不代表喜欢图里全部内容。元素名称、分析和备注都能修改。</p><h3>修改怎样同步？</h3><ol><li>网页修改先保存到当前浏览器，顶部显示“本机草稿”。</li><li>点击“导出更新”。只改文字和标记时导出 data.js；添加图片后导出 ZIP 更新包。</li><li>把文件上传到 Git 仓库原位置，等待 Pages 部署完成。</li><li>其他电脑重新打开网页，就能看到已上传的修改。</li></ol><h3>添加图片与继续分析</h3><p>新增图片保留原文件名，默认待分析，不会自动调用 AI。你可以手动补充元素，也可以把后续图片交给我继续分析。</p><h3>分享与权限</h3><p>查看链接默认隐藏编辑控件。它是界面模式，不是密码保护；只有有仓库写入权限的人才能更改线上文件。公开 GitHub Pages 与公开仓库中的资料可被他人访问。</p><h3>草稿与备份</h3><p>本机草稿不等于 Git 备份。清理浏览器数据、更换浏览器或使用无痕模式可能使草稿丢失。请及时导出。上传了新版 data.js 后，旧版本本机草稿不会自动覆盖新版。</p>`);break;
    }
  }

  document.addEventListener('click',(event) => {
    const button=event.target.closest('[data-action]');if(!button || button.disabled)return;
    handleAction(button).catch((error) => toast(error.message || '操作未完成，请重试。'));
  });
  document.addEventListener('submit',(event) => {if(event.target.id==='edit-form'){event.preventDefault();saveEditor(event.target);}});
  document.addEventListener('load',(event) => {
    if(event.target.matches?.('.photo-button img')) event.target.closest('.photo-wrap').classList.add('image-ready');
  },true);
  document.addEventListener('error',(event) => {
    if(!event.target.matches?.('.photo-button img'))return;
    const wrap=event.target.closest('.photo-wrap');const imageId=event.target.closest('.photo-button').dataset.image;
    wrap.classList.add('image-failed');
    wrap.querySelector('.image-loading').innerHTML=`<span>图片暂未读取</span><button class="button outline small" data-action="retry-image" data-image="${escape(imageId)}">重新加载图片</button>`;
  },true);
  document.addEventListener('input',(event) => {
    const elementId=event.target.dataset.noteText || event.target.dataset.noteSpace;
    if(!elementId || !state.selected) return;
    const key=`${state.selected}:${elementId}`;
    const draft=state.noteDrafts.get(key) || {...getElement(state.selected,elementId)};
    if(event.target.dataset.noteText) draft.note=event.target.value; else draft.targetSpace=event.target.value;
    state.noteDrafts.set(key,draft);
  });
  $('search').addEventListener('input',(event) => {state.search=event.target.value.trim();render();});
  for (const [id,key] of [['space-filter','space'],['category-filter','category'],['preference-filter','preference']]) {
    $(id).addEventListener('change',(event) => {state[key]=event.target.value;render();});
  }
  $('favorite-filter').addEventListener('change',(event) => {state.favorite=event.target.checked;render();});
  $('detail-dialog').addEventListener('cancel',() => {state.selected=null;updateAddress();});
  $('image-input').addEventListener('change',(event) => {addImages([...event.target.files]).catch((error) => toast(error.message));event.target.value='';});
  $('data-input').addEventListener('change',(event) => {const file=event.target.files[0];if(file)importData(file).catch((error) => toast(error instanceof SyntaxError?'文件无法解析，请选择导出的 JSON 或 data.js。':error.message));event.target.value='';});
  window.addEventListener('beforeunload',(event) => {
    if(state.data.images.some((image) => image._pendingAsset && !state.assetFiles.has(image.imageUrl))){event.preventDefault();event.returnValue='';}
  });

  async function init() {
    let restoreMessage='';
    try {
      const raw=localStorage.getItem(draftKey);
      if(raw){const draft=JSON.parse(raw);if(draft.baseRevision===canonical.revision){state.data=validateDataset(draft.data);state.dirty=true;restoreMessage='已恢复本机草稿；上传到 Git 后才会同步给其他人。';}
      else restoreMessage='已加载 Git 上的新版本；旧版本本机草稿未覆盖新资料。';}
    } catch {restoreMessage='本机草稿无法读取，已打开已上传的资料。';}
    for (const image of state.data.images.filter((item) => item._pendingAsset)) {
      try {const file=await readAsset(image.imageUrl);if(file){state.assetFiles.set(image.imageUrl,file);state.assetUrls.set(image.imageUrl,URL.createObjectURL(file));}else restoreMessage=`${image.filename} 的本机图片草稿缺失，请重新添加。`;}
      catch {restoreMessage='本机新增图片暂时无法读取，请检查浏览器存储权限。';}
    }
    refreshFilterOptions();render();
    if(state.selected && getImage(state.selected))openDetail(state.selected);
    if(restoreMessage)toast(restoreMessage);
  }
  init().catch((error) => { $('content').innerHTML=empty('图库未能正常加载','请刷新页面或检查 data.js 文件。');toast(error.message); });
})();
