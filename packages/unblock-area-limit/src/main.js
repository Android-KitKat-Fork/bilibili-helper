import { Objects } from './util/objects'
import { Converters } from './util/converters';
import { _ } from './util/react'
import { Async, Promise } from './util/async';
import { r, _t } from './feature/r'
import { util_error, util_info, util_log, util_warn, util_debug, logHub } from './util/log'
import { cookieStorage } from './util/cookie'
import { balh_config } from './feature/config'
import { Func } from './util/utils';
import { util_page } from './feature/page'
import { access_key_param_if_exist } from './api/bilibili';
import { BiliPlusApi } from './api/biliplus';
import { ui } from './util/ui'
import { Strings } from './util/strings'
import { util_init } from './util/initiator'
import { util_ui_msg } from './util/message'
import { RegExps } from './util/regexps'
import * as bili from './feature/bili';

function scriptContent() {
    'use strict';
    let log = console.log.bind(console, 'injector:')
    if (document.getElementById('balh-injector-source') && invokeBy === GM_info.scriptHandler) {
        // 当前, 在Firefox+GM4中, 当返回缓存的页面时, 脚本会重新执行, 并且此时XMLHttpRequest是可修改的(为什么会这样?) + 页面中存在注入的代码
        // 导致scriptSource的invokeBy直接是GM4...
        log(`页面中存在注入的代码, 但invokeBy却等于${GM_info.scriptHandler}, 这种情况不合理, 终止脚本执行`)
        return
    }
    if (document.readyState === 'uninitialized') { // Firefox上, 对于iframe中执行的脚本, 会出现这样的状态且获取到的href为about:blank...
        log('invokeBy:', invokeBy, 'readState:', document.readyState, 'href:', location.href, '需要等待进入loading状态')
        setTimeout(() => scriptSource(invokeBy + '.timeout'), 0) // 这里会暴力执行多次, 直到状态不为uninitialized...
        return
    }

    log = util_debug
    log(`[${GM_info.script.name} v${GM_info.script.version} (${invokeBy})] run on: ${window.location.href}`);

    const balh_is_close = false

    bili.version_remind()
    bili.switch_to_old_player()

    const balh_feature_area_limit_new = (function () {
        if (balh_is_close) return

        if (!(
            (util_page.av() && balh_config.enable_in_av) || util_page.new_bangumi()
        )) {
            return
        }
        function replacePlayInfo() {
            log("window.__playinfo__", window.__playinfo__)
            window.__playinfo__origin = window.__playinfo__
            let playinfo = undefined
            // 将__playinfo__置空, 让播放器去重新加载它...
            Object.defineProperty(window, '__playinfo__', {
                configurable: true,
                enumerable: true,
                get: () => {
                    log('__playinfo__', 'get')
                    return playinfo
                },
                set: (value) => {
                    // debugger
                    log('__playinfo__', 'set')
                    // 原始的playinfo为空, 且页面在loading状态, 说明这是html中对playinfo进行的赋值, 这个值可能是有区域限制的, 不能要
                    if (!window.__playinfo__origin && window.document.readyState === 'loading') {
                        log('__playinfo__', 'init in html', value)
                        window.__playinfo__origin = value
                        return
                    }
                    playinfo = value
                },
            })
        }
        function modifyGlobalValue(name, modifyFn) {
            const name_origin = `${name}_origin`
            window[name_origin] = window[name]
            let value = undefined
            Object.defineProperty(window, name, {
                configurable: true,
                enumerable: true,
                get: () => {
                    return value
                },
                set: (val) => {
                    value = modifyFn(val)
                }
            })
            if (window[name_origin]) {
                window[name] = window[name_origin]
            }
        }
        function replaceUserState() {
            modifyGlobalValue('__PGC_USERSTATE__', (value) => {
                if (value) {
                    // 区域限制
                    // todo      : 调用areaLimit(limit), 保存区域限制状态
                    // 2019-08-17: 之前的接口还有用, 这里先不保存~~
                    value.area_limit = 0
                    // 会员状态
                    if (balh_config.blocked_vip && value.vip_info) {
                        value.vip_info.status = 1
                        value.vip_info.type = 2
                    }
                }
                return value
            })
        }
        function replaceInitialState() {
            modifyGlobalValue('__INITIAL_STATE__', (value) => {
                if (value && value.epInfo && value.epList && balh_config.blocked_vip) {
                    for (let ep of [value.epInfo, ...value.epList]) {
                        // 13貌似表示会员视频, 2为普通视频
                        if (ep.epStatus === 13) {
                            log('epStatus 13 => 2', ep)
                            ep.epStatus = 2
                        }
                    }
                }
                if (value && value.mediaInfo && value.mediaInfo.rights && value.mediaInfo.rights.appOnly === true) {
                    value.mediaInfo.rights.appOnly = false
                    window.__app_only__ = true
                }
                return value
            })
        }
        replaceInitialState()
        replaceUserState()
        replacePlayInfo()
    })()

    const balh_feature_area_limit = (function () {
        if (balh_is_close) return

        function injectXHR() {
            util_debug('XMLHttpRequest的描述符:', Object.getOwnPropertyDescriptor(window, 'XMLHttpRequest'))
            let firstCreateXHR = true
            window.XMLHttpRequest = new Proxy(window.XMLHttpRequest, {
                construct: function (target, args) {
                    // 第一次创建XHR时, 打上断点...
                    if (firstCreateXHR && r.script.is_dev) {
                        firstCreateXHR = false
                        // debugger
                    }
                    let container = {} // 用来替换responseText等变量
                    const dispatchResultTransformer = p => {
                        let event = {} // 伪装的event
                        return p
                            .then(r => {
                                container.readyState = 4
                                container.response = r
                                container.__onreadystatechange(event) // 直接调用会不会存在this指向错误的问题? => 目前没看到, 先这样(;¬_¬)
                            })
                            .catch(e => {
                                // 失败时, 让原始的response可以交付
                                container.__block_response = false
                                if (container.__response != null) {
                                    container.readyState = 4
                                    container.response = container.__response
                                    container.__onreadystatechange(event) // 同上
                                }
                            })
                    }
                    return new Proxy(new target(...args), {
                        set: function (target, prop, value, receiver) {
                            if (prop === 'onreadystatechange') {
                                container.__onreadystatechange = value
                                let cb = value
                                value = function (event) {
                                    if (target.readyState === 4) {
                                        if (target.responseURL.match(RegExps.url('bangumi.bilibili.com/view/web_api/season/user/status'))
                                            || target.responseURL.match(RegExps.url('api.bilibili.com/pgc/view/web/season/user/status'))) {
                                            log('/season/user/status:', target.responseText)
                                            let json = JSON.parse(target.responseText)
                                            let rewriteResult = false
                                            if (json.code === 0 && json.result) {
                                                areaLimit(json.result.area_limit !== 0)
                                                if (json.result.area_limit !== 0) {
                                                    json.result.area_limit = 0 // 取消区域限制
                                                    rewriteResult = true
                                                }
                                                if (balh_config.blocked_vip) {
                                                    json.result.pay = 1
                                                    rewriteResult = true
                                                }
                                                if (rewriteResult) {
                                                    container.responseText = JSON.stringify(json)
                                                }
                                            }
                                        } else if (target.responseURL.match(RegExps.url('bangumi.bilibili.com/web_api/season_area'))) {
                                            log('/season_area', target.responseText)
                                            let json = JSON.parse(target.responseText)
                                            if (json.code === 0 && json.result) {
                                                areaLimit(json.result.play === 0)
                                                if (json.result.play === 0) {
                                                    json.result.play = 1
                                                    container.responseText = JSON.stringify(json)
                                                }
                                            }
                                        } else if (target.responseURL.match(RegExps.url('api.bilibili.com/x/web-interface/nav'))) {
                                            const isFromReport = Strings.getSearchParam(target.responseURL, 'from') === 'report'
                                            let json = JSON.parse(target.responseText)
                                            log('/x/web-interface/nav', (json.data && json.data.isLogin)
                                                ? { uname: json.data.uname, isLogin: json.data.isLogin, level: json.data.level_info.current_level, vipType: json.data.vipType, vipStatus: json.data.vipStatus, isFromReport: isFromReport }
                                                : target.responseText)
                                            if (json.code === 0 && json.data && balh_config.blocked_vip
                                                && !isFromReport // report时, 还是不伪装了...
                                            ) {
                                                json.data.vipType = 2; // 类型, 年度大会员
                                                json.data.vipStatus = 1; // 状态, 启用
                                                container.responseText = JSON.stringify(json)
                                            }
                                        } else if (target.responseURL.match(RegExps.url('api.bilibili.com/x/player.so'))) {
                                            // 这个接口的返回数据貌似并不会影响界面...
                                            if (balh_config.blocked_vip) {
                                                log('/x/player.so')
                                                const xml = new DOMParser().parseFromString(`<root>${target.responseText.replace(/\&/g, "&amp;")}</root>`, 'text/xml')
                                                const vipXml = xml.querySelector('vip')
                                                if (vipXml) {
                                                    const vip = JSON.parse(vipXml.innerHTML)
                                                    vip.vipType = 2 // 同上
                                                    vip.vipStatus = 1
                                                    vipXml.innerHTML = JSON.stringify(vip)
                                                    container.responseText = xml.documentElement.innerHTML
                                                    container.response = container.responseText
                                                }
                                            }
                                        } else if (target.responseURL.match(RegExps.url('api.bilibili.com/x/player/playurl'))) {
                                            log('/x/player/playurl', 'origin', `block: ${container.__block_response}`, target.response)
                                            // todo      : 当前只实现了r.const.mode.REPLACE, 需要支持其他模式
                                            // 2018-10-14: 等B站全面启用新版再说(;¬_¬)
                                        } else if (target.responseURL.match(RegExps.url('api.bilibili.com/pgc/player/web/playurl'))
                                            && !Strings.getSearchParam(target.responseURL, 'balh_ajax')) {
                                            log('/pgc/player/web/playurl', 'origin', `block: ${container.__block_response}`, target.response)
                                            if (!container.__redirect) { // 请求没有被重定向, 则需要检测结果是否有区域限制
                                                let json = target.response
                                                if (balh_config.blocked_vip || json.code || isAreaLimitForPlayUrl(json.result)) {
                                                    areaLimit(true)
                                                    container.__block_response = true
                                                    let url = container.__url
                                                    if (isBangumiPage()) {
                                                        url += `&module=bangumi`
                                                    }
                                                    bilibiliApis._playurl.asyncAjax(url)
                                                        .then(data => {
                                                            if (!data.code) {
                                                                data = { code: 0, result: data, message: "0" }
                                                            }
                                                            log('/pgc/player/web/playurl', 'proxy', data)
                                                            return data
                                                        })
                                                        .compose(dispatchResultTransformer)
                                                } else {
                                                    areaLimit(false)
                                                }
                                            }
                                            // 同上
                                        }
                                        if (container.__block_response) {
                                            // 屏蔽并保存response
                                            container.__response = target.response
                                            return
                                        }
                                    }
                                    // 这里的this是原始的xhr, 在container.responseText设置了值时需要替换成代理对象
                                    cb.apply(container.responseText ? receiver : this, arguments)
                                }
                            }
                            target[prop] = value
                            return true
                        },
                        get: function (target, prop, receiver) {
                            if (prop in container) return container[prop]
                            let value = target[prop]
                            if (typeof value === 'function') {
                                let func = value
                                // open等方法, 必须在原始的xhr对象上才能调用...
                                value = function () {
                                    if (prop === 'open') {
                                        container.__method = arguments[0]
                                        container.__url = arguments[1]
                                    } else if (prop === 'send') {
                                        let dispatchResultTransformerCreator = () => {
                                            container.__block_response = true
                                            return dispatchResultTransformer
                                        }
                                        if (container.__url.match(RegExps.url('api.bilibili.com/x/player/playurl')) && balh_config.enable_in_av) {
                                            log('/x/player/playurl')
                                            // debugger
                                            bilibiliApis._playurl.asyncAjax(container.__url)
                                                .then(data => {
                                                    if (!data.code) {
                                                        data = {
                                                            code: 0,
                                                            data: data,
                                                            message: "0",
                                                            ttl: 1
                                                        }
                                                    }
                                                    log('/x/player/playurl', 'proxy', data)
                                                    return data
                                                })
                                                .compose(dispatchResultTransformerCreator())
                                        } else if (container.__url.match(RegExps.url('api.bilibili.com/pgc/player/web/playurl'))
                                            && !Strings.getSearchParam(container.__url, 'balh_ajax')
                                            && needRedirect()) {
                                            log('/pgc/player/web/playurl')
                                            // debugger
                                            container.__redirect = true // 标记该请求被重定向
                                            let url = container.__url
                                            if (isBangumiPage()) {
                                                url += `&module=bangumi`
                                            }
                                            bilibiliApis._playurl.asyncAjax(url)
                                                .then(data => {
                                                    if (!data.code) {
                                                        data = {
                                                            code: 0,
                                                            result: data,
                                                            message: "0",
                                                        }
                                                    }
                                                    log('/pgc/player/web/playurl', 'proxy(redirect)', data)
                                                    return data
                                                })
                                                .compose(dispatchResultTransformerCreator())
                                        }
                                    }
                                    return func.apply(target, arguments)
                                }
                            }
                            return value
                        }
                    })
                }
            })
        }

        function injectAjax() {
            log('injectAjax at:', window.jQuery)
            let originalAjax = $.ajax;
            $.ajax = function (arg0, arg1) {
                let param;
                if (arg1 === undefined) {
                    param = arg0;
                } else {
                    arg0 && (arg1.url = arg0);
                    param = arg1;
                }
                let oriSuccess = param.success;
                let oriError = param.error;
                let mySuccess, myError;
                // 投递结果的transformer, 结果通过oriSuccess/Error投递
                let dispatchResultTransformer = p => p
                    .then(r => {
                        // debugger
                        oriSuccess(r)
                    })
                    .catch(e => oriError(e))
                // 转换原始请求的结果的transformer
                let oriResultTransformer
                let oriResultTransformerWhenProxyError
                let one_api;
                // log(param)
                if (param.url.match(RegExps.urlPath('/web_api/get_source'))) {
                    one_api = bilibiliApis._get_source;
                    oriResultTransformer = p => p
                        .then(json => {
                            log(json);
                            if (json.code === -40301 // 区域限制
                                || json.result.payment && json.result.payment.price != 0 && balh_config.blocked_vip) { // 需要付费的视频, 此时B站返回的cid是错了, 故需要使用代理服务器的接口
                                areaLimit(true);
                                return one_api.asyncAjax(param.url)
                                    .catch(e => json)// 新的请求报错, 也应该返回原来的数据
                            } else {
                                areaLimit(false);
                                if ((balh_config.blocked_vip || balh_config.remove_pre_ad) && json.code === 0 && json.result.pre_ad) {
                                    json.result.pre_ad = 0; // 去除前置广告
                                }
                                return json;
                            }
                        })
                } else if (param.url.match(RegExps.urlPath('/player/web_api/playurl')) // 老的番剧页面playurl接口
                    || param.url.match(RegExps.urlPath('/player/web_api/v2/playurl')) // 新的番剧页面playurl接口
                    || param.url.match(RegExps.url('api.bilibili.com/pgc/player/web/playurl')) // 新的番剧页面playurl接口
                    || (balh_config.enable_in_av && param.url.match(RegExps.url('interface.bilibili.com/v2/playurl'))) // 普通的av页面playurl接口
                ) {
                    // 新playrul:
                    // 1. 部分页面参数放在param.data中
                    // 2. 成功时, 返回的结果放到了result中: {"code":0,"message":"success","result":{}}
                    // 3. 失败时, 返回的结果没变
                    let isNewPlayurl
                    if (isNewPlayurl = param.url.match(RegExps.url('api.bilibili.com/pgc/player/web/playurl'))) {
                        if (param.data) {
                            param.url += `?${Object.keys(param.data).map(key => `${key}=${param.data[key]}`).join('&')}`
                            param.data = undefined
                        }
                        if (isBangumiPage()) {
                            log(`playurl add 'module=bangumi' param`)
                            param.url += `&module=bangumi`
                        }
                        // 加上这个参数, 防止重复拦截这个url
                        param.url += `&balh_ajax=1`
                    }
                    one_api = bilibiliApis._playurl;
                    if (isNewPlayurl) {
                        oriResultTransformerWhenProxyError = p => p
                            .then(json => !json.code ? json.result : json)
                    }
                    oriResultTransformer = p => p
                        .then(json => {
                            log(json)
                            if (isNewPlayurl && !json.code) {
                                json = json.result
                            }
                            if (balh_config.blocked_vip || json.code || isAreaLimitForPlayUrl(json)) {
                                areaLimit(true)
                                return one_api.asyncAjax(param.url)
                                    .catch(e => json)
                            } else {
                                areaLimit(false)
                                return json
                            }
                        })
                    const oriDispatchResultTransformer = dispatchResultTransformer
                    dispatchResultTransformer = p => p
                        .then(r => {
                            if (!r.code && !r.from && !r.result && !r.accept_description) {
                                util_warn('playurl的result缺少必要的字段:', r)
                                r.from = 'local'
                                r.result = 'suee'
                                r.accept_description = ['未知 3P']
                                // r.timelength = r.durl.map(it => it.length).reduce((a, b) => a + b, 0)
                                if (r.durl && r.durl[0] && r.durl[0].url.includes('video-sg.biliplus.com')) {
                                    const aid = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.aid || window.__INITIAL_STATE__.epInfo && window.__INITIAL_STATE__.epInfo.aid || 'fuck'
                                    ui.pop({
                                        content: `原视频已被删除, 当前播放的是<a href="https://video-sg.biliplus.com/">转存服务器</a>中的视频, 速度较慢<br>被删的原因可能是:<br>1. 视频违规<br>2. 视频被归类到番剧页面 => 试下<a href="https://search.bilibili.com/bangumi?keyword=${aid}">搜索av${aid}</a>`
                                    })
                                }
                            }
                            if (isNewPlayurl && !r.code) {
                                r = {
                                    code: 0,
                                    message: 'success',
                                    result: r
                                }
                            }
                            return r
                        })
                        .compose(oriDispatchResultTransformer)
                } else if (param.url.match(RegExps.url('interface.bilibili.com/player?'))) {
                    if (balh_config.blocked_vip) {
                        mySuccess = function (data) {
                            try {
                                let xml = new window.DOMParser().parseFromString(`<userstatus>${data.replace(/\&/g, '&amp;')}</userstatus>`, 'text/xml');
                                let vipTag = xml.querySelector('vip');
                                if (vipTag) {
                                    let vip = JSON.parse(vipTag.innerHTML);
                                    vip.vipType = 2; // 类型, 年度大会员
                                    vip.vipStatus = 1; // 状态, 启用
                                    vipTag.innerHTML = JSON.stringify(vip);
                                    data = xml.documentElement.innerHTML;
                                }
                            } catch (e) {
                                log('parse xml error: ', e);
                            }
                            oriSuccess(data);
                        };
                    }
                } else if (param.url.match(RegExps.url('api.bilibili.com/x/ad/video?'))) {
                    if (balh_config.remove_pre_ad) {
                        mySuccess = function (data) {
                            log('/ad/video', data)
                            if (data && data.code === 0 && data.data) {
                                data.data = [] // 移除广告接口返回的数据
                            }
                            oriSuccess(data)
                        }
                    }
                }

                if (one_api && oriResultTransformer) {
                    // 请求结果通过mySuccess/Error获取, 将其包装成Promise, 方便处理
                    let oriResultPromise = new Promise((resolve, reject) => {
                        mySuccess = resolve
                        myError = reject
                    })
                    if (needRedirect()) {
                        // 通过proxy, 执行请求
                        one_api.asyncAjax(param.url)
                            // proxy报错时, 返回原始请求的结果
                            .catch(e => oriResultPromise.compose(oriResultTransformerWhenProxyError))
                            .compose(dispatchResultTransformer)
                    } else {
                        oriResultPromise
                            .compose(oriResultTransformer)
                            .compose(dispatchResultTransformer)
                    }
                }

                // 若外部使用param.success处理结果, 则替换param.success
                if (oriSuccess && mySuccess) {
                    param.success = mySuccess;
                }
                // 处理替换error
                if (oriError && myError) {
                    param.error = myError;
                }
                // default
                let xhr = originalAjax.apply(this, [param]);

                // 若外部使用xhr.done()处理结果, 则替换xhr.done()
                if (!oriSuccess && mySuccess) {
                    xhr.done(mySuccess);
                    xhr.done = function (success) {
                        oriSuccess = success; // 保存外部设置的success函数
                        return xhr;
                    };
                }
                // 处理替换error
                if (!oriError && myError) {
                    xhr.fail(myError);
                    xhr.fail = function (error) {
                        oriError = error;
                        return xhr;
                    }
                }
                return xhr;
            };
        }

        function injectFetch() {
            window.fetch = Async.wrapper(window.fetch,
                resp => new Proxy(resp, {
                    get: function (target, prop, receiver) {
                        if (prop === 'json') {
                            return Async.wrapper(target.json.bind(target),
                                oriResult => {
                                    util_debug('injectFetch:', target.url)
                                    if (target.url.match(RegExps.urlPath('/player/web_api/v2/playurl/html5'))) {
                                        let cid = Strings.getSearchParam(target.url, 'cid')
                                        return BiliPlusApi.playurl(cid)
                                            .then(result => {
                                                if (result.code) {
                                                    return Promise.reject('error: ' + JSON.stringify(result))
                                                } else {
                                                    return BiliPlusApi.playurl_for_mp4(cid)
                                                        .then(url => {
                                                            util_debug(`mp4地址, 移动版: ${url}, pc版: ${result.durl[0].url}`)
                                                            return {
                                                                "code": 0,
                                                                "cid": `http://comment.bilibili.com/${cid}.xml`,
                                                                "timelength": result.timelength,
                                                                "src": url || result.durl[0].url, // 只取第一个片段的url...
                                                            }
                                                        })
                                                }
                                            })
                                            .catch(e => {
                                                // 若拉取视频地址失败, 则返回原始的结果
                                                log('fetch mp4 url failed', e)
                                                return oriResult
                                            })
                                    }
                                    return oriResult
                                },
                                error => error)
                        }
                        return target[prop]
                    }
                }),
                error => error)
        }

        function isAreaLimitSeason() {
            return cookieStorage['balh_season_' + getSeasonId()];
        }

        function needRedirect() {
            return balh_config.mode === r.const.mode.REDIRECT || (balh_config.mode === r.const.mode.DEFAULT && isAreaLimitSeason())
        }

        function areaLimit(limit) {
            balh_config.mode === r.const.mode.DEFAULT && setAreaLimitSeason(limit)
        }

        function setAreaLimitSeason(limit) {
            var season_id = getSeasonId();
            cookieStorage.set('balh_season_' + season_id, limit ? '1' : undefined, ''); // 第三个参数为'', 表示时Session类型的cookie
            log('setAreaLimitSeason', season_id, limit);
        }
        /** 使用该方法判断是否需要添加module=bangumi参数, 并不准确... */
        function isBangumi(season_type) {
            log(`season_type: ${season_type}`)
            // 1: 动画
            // 2: 电影
            // 3: 纪录片
            // 4: 国创
            // 5: 电视剧
            return season_type != null // 存在season_type就是bangumi?
        }

        function isBangumiPage() {
            return isBangumi(Func.safeGet('window.__INITIAL_STATE__.mediaInfo.season_type || window.__INITIAL_STATE__.mediaInfo.ssType'))
        }

        function getSeasonId() {
            var seasonId;
            // 取anime页面的seasonId
            try {
                // 若w, 是其frame的window, 则有可能没有权限, 而抛异常
                seasonId = window.season_id || window.top.season_id;
            } catch (e) {
                log(e);
            }
            if (!seasonId) {
                try {
                    seasonId = (window.top.location.pathname.match(/\/anime\/(\d+)/) || ['', ''])[1];
                } catch (e) {
                    log(e);
                }
            }

            // 若没取到, 则取movie页面的seasonId, 以m开头
            if (!seasonId) {
                try {
                    seasonId = (window.top.location.pathname.match(/\/movie\/(\d+)/) || ['', ''])[1];
                    if (seasonId) {
                        seasonId = 'm' + seasonId;
                    }
                } catch (e) {
                    log(e);
                }
            }

            // 若没取到, 则去新的番剧播放页面的ep或ss
            if (!seasonId) {
                try {
                    seasonId = (window.top.location.pathname.match(/\/bangumi\/play\/((ep|ss)\d+)/) || ['', ''])[1];
                } catch (e) {
                    log(e);
                }
            }
            // 若没取到, 则去取av页面的av号
            if (!seasonId) {
                try {
                    seasonId = (window.top.location.pathname.match(/\/video\/((av|BV)\w+)/) || ['', ''])[1]
                } catch (e) {
                    log(e);
                }
            }
            // 最后, 若没取到, 则试图取出当前页面url中的aid
            if (!seasonId) {
                seasonId = Strings.getSearchParam(window.location.href, 'aid');
                if (seasonId) {
                    seasonId = 'aid' + seasonId;
                }
            }
            return seasonId || '000';
        }

        function isAreaLimitForPlayUrl(json) {
            return (json.errorcid && json.errorcid == '8986943') || (json.durl && json.durl.length === 1 && json.durl[0].length === 15126 && json.durl[0].size === 124627);
        }

        var bilibiliApis = (function () {
            function AjaxException(message, code = 0/*用0表示未知错误*/) {
                this.name = 'AjaxException'
                this.message = message
                this.code = code
            }
            AjaxException.prototype.toString = function () {
                return `${this.name}: ${this.message}(${this.code})`
            }
            function BilibiliApi(props) {
                Object.assign(this, props);
            }

            BilibiliApi.prototype.asyncAjaxByProxy = function (originUrl, success, error) {
                var one_api = this;
                $.ajax({
                    url: one_api.transToProxyUrl(originUrl),
                    async: true,
                    xhrFields: { withCredentials: true },
                    success: function (result) {
                        log('==>', result);
                        success(one_api.processProxySuccess(result));
                        // log('success', arguments, this);
                    },
                    error: function (e) {
                        log('error', arguments, this);
                        error(e);
                    }
                });
            };
            BilibiliApi.prototype.asyncAjax = function (originUrl) {
                return Async.ajax(this.transToProxyUrl(originUrl))
                    .then(r => this.processProxySuccess(r))
                    .compose(util_ui_msg.showOnNetErrorInPromise()) // 出错时, 提示服务器连不上
            }
            var get_source_by_aid = new BilibiliApi({
                transToProxyUrl: function (url) {
                    return balh_config.server + '/api/view?id=' + window.aid + `&update=true${access_key_param_if_exist()}`;
                },
                processProxySuccess: function (data) {
                    if (data && data.list && data.list[0] && data.movie) {
                        return {
                            code: 0,
                            message: 'success',
                            result: {
                                cid: data.list[0].cid,
                                formal_aid: data.aid,
                                movie_status: balh_config.blocked_vip ? 2 : data.movie.movie_status, // 2, 大概是免费的意思?
                                pay_begin_time: 1507708800,
                                pay_timestamp: 0,
                                pay_user_status: data.movie.pay_user.status, // 一般都是0
                                player: data.list[0].type, // 一般为movie
                                vid: data.list[0].vid,
                                vip: { // 2+1, 表示年度大会员; 0+0, 表示普通会员
                                    vipType: balh_config.blocked_vip ? 2 : 0,
                                    vipStatus: balh_config.blocked_vip ? 1 : 0,
                                }
                            }
                        };
                    } else {
                        return {
                            code: -404,
                            message: '不存在该剧集'
                        };
                    }
                }
            });
            var get_source_by_season_id = new BilibiliApi({
                transToProxyUrl: function (url) {
                    return balh_config.server + '/api/bangumi?season=' + window.season_id + access_key_param_if_exist();
                },
                processProxySuccess: function (data) {
                    var found = null;
                    if (!data.code) {
                        for (var i = 0; i < data.result.episodes.length; i++) {
                            if (data.result.episodes[i].episode_id == window.episode_id) {
                                found = data.result.episodes[i];
                            }
                        }
                    } else {
                        ui.alert('代理服务器错误:' + JSON.stringify(data) + '\n点击刷新界面.', window.location.reload.bind(window.location));
                    }
                    var returnVal = found !== null
                        ? {
                            "code": 0,
                            "message": "success",
                            "result": {
                                "aid": found.av_id,
                                "cid": found.danmaku,
                                "episode_status": balh_config.blocked_vip ? 2 : found.episode_status,
                                "payment": { "price": "9876547210.33" },
                                "pay_user": {
                                    "status": balh_config.blocked_vip ? 1 : 0 // 是否已经支付过
                                },
                                "player": "vupload",
                                "pre_ad": 0,
                                "season_status": balh_config.blocked_vip ? 2 : data.result.season_status
                            }
                        }
                        : { code: -404, message: '不存在该剧集' };
                    return returnVal;
                }
            });
            var playurl_by_bilibili = new BilibiliApi({
                dataType: 'xml',
                transToProxyUrl: function (originUrl) {
                    const api_url = 'https://interface.bilibili.com/playurl?'
                    const bangumi_api_url = 'https://bangumi.bilibili.com/player/web_api/playurl?'
                    const SEC_NORMAL = '1c15888dc316e05a15fdd0a02ed6584f'
                    const SEC_BANGUMI = '9b288147e5474dd2aa67085f716c560d'

                    // 不设置module; 带module的接口都是有区域限制的...
                    let module = undefined /*Strings.getSearchParam(originUrl, 'module')*/
                    // 不使用json; 让服务器直接返回json时, 获取的视频url不能直接播放...天知道为什么
                    let useJson = false
                    let paramDict = {
                        cid: Strings.getSearchParam(originUrl, 'cid'),
                        quality: Strings.getSearchParam(originUrl, 'quality'),
                        qn: Strings.getSearchParam(originUrl, 'qn'), // 增加这个参数, 返回的清晰度更多
                        player: 1,
                        ts: Math.floor(Date.now() / 1000),
                    }
                    if (localStorage.access_key) {
                        paramDict.access_key = localStorage.access_key
                    }
                    if (module) paramDict.module = module
                    if (useJson) paramDict.otype = 'json'
                    let { sign, params } = Converters.generateSign(paramDict, module ? SEC_BANGUMI : SEC_NORMAL)
                    let url = module ? bangumi_api_url : api_url + params + '&sign=' + sign
                    return url
                },
                processProxySuccess: function (result, alertWhenError = true) {
                    // 将xml解析成json
                    let obj = Converters.xml2obj(result.documentElement)
                    if (!obj || obj.code) {
                        if (alertWhenError) {
                            ui.alert(`从B站接口获取视频地址失败\nresult: ${JSON.stringify(obj)}\n\n点击确定, 进入设置页面关闭'使用B站接口获取视频地址'功能`, balh_ui_setting.show)
                        } else {
                            return Promise.reject(`服务器错误: ${JSON.stringify(obj)}`)
                        }
                    } else {
                        obj.accept_quality && (obj.accept_quality = obj.accept_quality.split(',').map(n => +n))
                        if (!obj.durl.push) {
                            obj.durl = [obj.durl]
                        }
                        obj.durl.forEach((item) => {
                            if (item.backup_url === '') {
                                item.backup_url = undefined
                            } else if (item.backup_url && item.backup_url.url) {
                                item.backup_url = item.backup_url.url
                            }
                        })
                    }
                    log('xml2obj', result, '=>', obj)
                    return obj
                },
                _asyncAjax: function (originUrl) {
                    return Async.ajax(this.transToProxyUrl(originUrl))
                        .then(r => this.processProxySuccess(r, false))
                }
            })
            var playurl_by_proxy = new BilibiliApi({
                _asyncAjax: function (originUrl, bangumi) {
                    return Async.ajax(this.transToProxyUrl(originUrl, bangumi))
                        .then(r => this.processProxySuccess(r, false))
                },
                transToProxyUrl: function (url, bangumi) {
                    let params = url.split('?')[1];
                    if (bangumi === undefined) { // 自动判断
                        // av页面中的iframe标签形式的player, 不是番剧视频
                        bangumi = !util_page.player_in_av()
                        // url中存在season_type的情况
                        let season_type_param = Strings.getSearchParam(url, 'season_type')
                        if (season_type_param && !isBangumi(+season_type_param)) {
                            bangumi = false
                        }
                        if (!bangumi) {
                            params = params.replace(/&?module=(\w+)/, '') // 移除可能存在的module参数
                        }
                    } else if (bangumi === true) { // 保证添加module=bangumi参数
                        params = params.replace(/&?module=(\w+)/, '')
                        params += '&module=bangumi'
                    } else if (bangumi === false) { // 移除可能存在的module参数
                        params = params.replace(/&?module=(\w+)/, '')
                    }
                    // 管他三七二十一, 强行将module=bangumi替换成module=pgc _(:3」∠)_
                    params = params.replace(/(&?module)=bangumi/, '$1=pgc')
                    return `${balh_config.server}/BPplayurl.php?${params}${access_key_param_if_exist()}${window.__app_only__ ? '&platform=android&fnval=0' : ''}`;
                },
                processProxySuccess: function (data, alertWhenError = true) {
                    // data有可能为null
                    if (data && data.code === -403) {
                        ui.pop({
                            content: `<b>code-403</b>: <i style="font-size:4px;white-space:nowrap;">${JSON.stringify(data)}</i>\n\n当前代理服务器（${balh_config.server}）依然有区域限制\n\n可以考虑进行如下尝试:\n1. 进行“帐号授权”\n2. 换个代理服务器\n3. 耐心等待服务端修复问题\n\n点击确定, 打开设置页面`,
                            onConfirm: balh_ui_setting.show,
                        })
                    } else if (data === null || data.code) {
                        util_error(data);
                        if (alertWhenError) {
                            ui.alert(`突破黑洞失败\n${JSON.stringify(data)}\n点击确定刷新界面`, window.location.reload.bind(window.location));
                        } else {
                            return Promise.reject(new AjaxException(`服务器错误: ${JSON.stringify(data)}`, data ? data.code : 0))
                        }
                    } else if (isAreaLimitForPlayUrl(data)) {
                        util_error('>>area limit');
                        ui.pop({
                            content: `突破黑洞失败\n需要登录\n点此确定进行登录`,
                            onConfirm: balh_feature_sign.showLogin
                        })
                    } else {
                        if (balh_config.flv_prefer_ws) {
                            data.durl.forEach(function (seg) {
                                var t, url, i;
                                if (!seg.url.includes('ws.acgvideo.com')) {
                                    for (i in seg.backup_url) {
                                        url = seg.backup_url[i];
                                        if (url.includes('ws.acgvideo.com')) {
                                            log('flv prefer use:', url);
                                            t = seg.url;
                                            seg.url = url;
                                            url = t;
                                            break;
                                        }
                                    }

                                }
                            });
                        }
                    }
                    return data;
                }
            })
            // https://github.com/kghost/bilibili-area-limit/issues/3
            const playurl_by_kghost = new BilibiliApi({
                _asyncAjax: function (originUrl) {
                    const proxyHostMap = [
                        [/僅.*台.*地區/, '//bilibili-tw-api.kghost.info/'],
                        [/僅.*港.*地區/, '//bilibili-hk-api.kghost.info/'],
                        [/仅限东南亚/, '//bilibili-sg-api.kghost.info/'],
                        [/.*/, '//bilibili-cn-api.kghost.info/'],
                    ];
                    let proxyHost
                    for (const [regex, host] of proxyHostMap) {
                        if (document.title.match(regex)) {
                            proxyHost = host
                            break;
                        }
                    }
                    if (proxyHost) {
                        return Async.ajax(this.transToProxyUrl(originUrl, proxyHost))
                            .then(r => this.processProxySuccess(r))
                    } else {
                        return Promise.reject("没有支持的服务器")
                    }
                },
                transToProxyUrl: function (originUrl, proxyHost) {
                    return originUrl.replace(/^(https:)?(\/\/api\.bilibili\.com\/)/, `$1${proxyHost}`) + access_key_param_if_exist(true);
                },
                processProxySuccess: function (result) {
                    if (result.code) {
                        return Promise.reject(result)
                    }
                    return result.result
                },
            })
            const playurl_by_custom = new BilibiliApi({
                _asyncAjax: function (originUrl) {
                    return Async.ajax(this.transToProxyUrl(originUrl, balh_config.server_custom))
                        .then(r => this.processProxySuccess(r))
                },
                transToProxyUrl: function (originUrl, proxyHost) {
                    return originUrl.replace(/^(https:)?(\/\/api\.bilibili\.com\/)/, `$1${proxyHost}/`) + access_key_param_if_exist(true);
                },
                processProxySuccess: function (result) {
                    if (result.code) {
                        return Promise.reject(result)
                    }
                    return result.result
                },
            })
            const playurl = new BilibiliApi({
                asyncAjax: function (originUrl) {
                    ui.playerMsg(`从${r.const.server.CUSTOM === balh_config.server_inner ? '自定义' : '代理'}服务器拉取视频地址中...`)
                    return (r.const.server.CUSTOM === balh_config.server_inner ? playurl_by_custom._asyncAjax(originUrl) : (playurl_by_proxy._asyncAjax(originUrl) // 优先从代理服务器获取
                        .catch(e => {
                            if (e instanceof AjaxException) {
                                ui.playerMsg(e)
                                if (e.code === 1 // code: 1 表示非番剧视频, 不能使用番剧视频参数
                                    || (Strings.getSearchParam(originUrl, 'module') === 'bangumi' && e.code === -404)) { // 某些番剧视频又不需要加module=bangumi, 详见: https://github.com/ipcjs/bilibili-helper/issues/494
                                    ui.playerMsg('尝试使用非番剧视频接口拉取视频地址...')
                                    return playurl_by_proxy._asyncAjax(originUrl, false)
                                        .catch(e2 => Promise.reject(e)) // 忽略e2, 返回原始错误e
                                } else if (e.code === 10004) { // code: 10004, 表示视频被隐藏, 一般添加module=bangumi参数可以拉取到视频
                                    ui.playerMsg('尝试使用番剧视频接口拉取视频地址...')
                                    return playurl_by_proxy._asyncAjax(originUrl, true)
                                        .catch(e2 => Promise.reject(e))
                                }
                            }
                            return Promise.reject(e)
                        })))
                        .catch(e => {
                            if ((typeof e === 'object' && e.statusText == 'error')
                                || (e instanceof AjaxException && e.code === -502)
                                || (typeof e === 'object' && e.code === -10403)
                            ) {
                                ui.playerMsg('尝试使用kghost的服务器拉取视频地址...')
                                return playurl_by_kghost._asyncAjax(originUrl)
                                    .catch(e2 => Promise.reject(e))
                            }
                            return Promise.reject(e)
                        })
                        // 报错时, 延时1秒再发送错误信息
                        .catch(e => util_promise_timeout(1000).then(r => Promise.reject(e)))
                        .catch(e => {
                            let msg
                            if (typeof e === 'object' && e.statusText == 'error') {
                                msg = '代理服务器临时不可用'
                                ui.playerMsg(msg)
                            } else {
                                msg = Objects.stringify(e)
                            }
                            ui.pop({
                                content: `## 拉取视频地址失败\n原因: ${msg}\n\n可以考虑进行如下尝试:\n1. 多<a href="">刷新</a>几下页面\n2. 进入<a href="javascript:bangumi_area_limit_hack.showSettings();">设置页面</a>更换代理服务器\n3. 耐心等待代理服务器端修复问题`,
                                onConfirm: window.location.reload.bind(window.location),
                                confirmBtn: '刷新页面'
                            })
                            return Promise.reject(e)
                        })
                        .then(data => {
                            if (data.dash) {
                                // dash中的字段全部变成了类似C语言的下划线风格...
                                Objects.convertKeyToSnakeCase(data.dash)
                            }
                            return data
                        })
                }
            })
            return {
                _get_source: util_page.movie() ? get_source_by_aid : get_source_by_season_id,
                _playurl: playurl,
            };
        })();

        if (util_page.anime_ep_m() || util_page.anime_ss_m()) {
            // BiliPlusApi.playurl_for_mp4返回的url能在移动设备上播放的前提是, 请求头不包含Referer...
            // 故这里设置meta, 使页面不发送Referer
            // 注意动态改变引用策略的方式并不是标准行为, 目前在Chrome上测试是有用的
            document.head.appendChild(_('meta', { name: "referrer", content: "no-referrer" }))
            injectFetch()
            util_init(() => {
                const $wrapper = document.querySelector('.player-wrapper')
                new MutationObserver(function (mutations, observer) {
                    for (let mutation of mutations) {
                        if (mutation.type === 'childList') {
                            for (let node of mutation.addedNodes) {
                                if (node.tagName === 'DIV' && node.className.split(' ').includes('player-mask')) {
                                    log('隐藏添加的mask')
                                    node.style.display = 'none'
                                }
                            }
                        }
                    }
                }).observe($wrapper, {
                    childList: true,
                    attributes: false,
                });
            })
        }
        injectXHR();
        if (true) {
            let jQuery = window.jQuery;
            if (jQuery) { // 若已加载jQuery, 则注入
                injectAjax()
            }
            // 需要监听jQuery变化, 因为有时会被设置多次...
            Object.defineProperty(window, 'jQuery', {
                configurable: true, enumerable: true, set: function (v) {
                    // debugger
                    log('set jQuery', jQuery, '->', v)
                    // 临时规避这个问题：https://github.com/ipcjs/bilibili-helper/issues/297
                    // 新的av页面中, 运行脚本的 injectXHR() 后, 页面会往该方法先后设置两个jQuery...原因未知
                    // 一个从jquery.min.js中设置, 一个从player.js中设置
                    // 并且点击/载入等事件会从两个jQuery中向下分发...导致很多功能失常
                    // 这里我们屏蔽掉jquery.min.js分发的一些事件, 避免一些问题
                    if (util_page.av_new() && balh_config.enable_in_av) {
                        try { // 获取调用栈的方法不是标准方法, 需要try-catch
                            const stack = (new Error()).stack.split('\n')
                            if (stack[stack.length - 1].includes('jquery')) { // 若从jquery.min.js中调用
                                log('set jQueury by jquery.min.js', v)
                                v.fn.balh_on = v.fn.on
                                v.fn.on = function (arg0, arg1) {
                                    if (arg0 === 'click.reply' && arg1 === '.reply') {
                                        // 屏蔽掉"回复"按钮的点击事件
                                        log('block click.reply', arguments)
                                        return
                                    }
                                    return v.fn.balh_on.apply(this, arguments)
                                }
                            }
                            // jQuery.fn.paging方法用于创建评论区的页标, 需要迁移到新的jQuery上
                            if (jQuery != null && jQuery.fn.paging != null
                                && v != null && v.fn.paging == null) {
                                log('迁移jQuery.fn.paging')
                                v.fn.paging = jQuery.fn.paging
                            }
                        } catch (e) {
                            util_error(e)
                        }
                    }

                    jQuery = v;
                    injectAjax();// 设置jQuery后, 立即注入
                }, get: function () {
                    return jQuery;
                }
            });
        }
    }())
    const balh_feature_remove_pre_ad = (function () {
        if (util_page.player()) {
            // 播放页面url中的pre_ad参数, 决定是否播放广告...
            if (balh_config.remove_pre_ad && Strings.getSearchParam(location.href, 'pre_ad') == 1) {
                log('需要跳转到不含广告的url')
                location.href = location.href.replace(/&?pre_ad=1/, '')
            }
        }
    }())

    bili.check_html5()

    const balh_feature_runPing = function () {
        var pingOutput = document.getElementById('balh_server_ping');

        var xhr = new XMLHttpRequest(), testUrl = [r.const.server.S0, r.const.server.S1],
            testUrlIndex = 0, isReused = false, prevNow, outputArr = [];
        if (balh_config.server_custom) {
            testUrl.push(balh_config.server_custom)
        }
        pingOutput.textContent = '正在进行服务器测速…';
        pingOutput.style.height = '100px';
        xhr.open('GET', '', true);
        xhr.onreadystatechange = function () {
            this.readyState == 4 && pingResult();
        };
        var pingLoop = function () {
            prevNow = performance.now();
            xhr.open('GET', testUrl[testUrlIndex] + '/api/bangumi', true);
            xhr.send();
        };
        var pingResult = function () {
            var duration = (performance.now() - prevNow) | 0;
            if (isReused)
                outputArr.push('\t复用连接：' + duration + 'ms'), isReused = false, testUrlIndex++;
            else
                outputArr.push(testUrl[testUrlIndex] + ':'), outputArr.push('\t初次连接：' + duration + 'ms'), isReused = true;
            pingOutput.textContent = outputArr.join('\n');
            testUrlIndex < testUrl.length ? pingLoop() : pingOutput.appendChild(_('a', { href: 'javascript:', event: { click: balh_feature_runPing } }, [_('text', '\n再测一次？')]));
        };
        pingLoop();
    }
    const balh_feature_sign = (function () {
        function isLogin() {
            return localStorage.oauthTime !== undefined
        }
        function clearLoginFlag() {
            delete localStorage.oauthTime
        }

        function updateLoginFlag(loadCallback) {
            Async.jsonp(balh_config.server + '/login?act=expiretime')
                .then(() => loadCallback && loadCallback(true))
            // .catch(() => loadCallback && loadCallback(false)) // 请求失败不需要回调
        }
        function isLoginBiliBili() {
            return cookieStorage['DedeUserID'] !== undefined
        }
        // 当前在如下情况才会弹一次登录提示框:
        // 1. 第一次使用
        // 2. 主站+服务器都退出登录后, 再重新登录主站
        function checkLoginState() {
            // 给一些状态，设置初始值
            localStorage.balh_must_remind_login_v3 === undefined && (localStorage.balh_must_remind_login_v3 = r.const.TRUE)

            if (isLoginBiliBili()) {
                if (!localStorage.balh_old_isLoginBiliBili // 主站 不登录 => 登录
                    || localStorage.balh_pre_server !== balh_config.server // 代理服务器改变了
                    || localStorage.balh_must_remind_login_v3) { // 设置了"必须提醒"flag
                    clearLoginFlag()
                    updateLoginFlag(() => {
                        if (!isLogin() || !localStorage.access_key) {
                            localStorage.balh_must_remind_login_v3 = r.const.FALSE;
                            ui.pop({
                                content: [
                                    _('text', `${GM_info.script.name}\n要不要考虑进行一下授权？\n\n授权后可以观看区域限定番剧的1080P\n（如果你是大会员或承包过这部番的话）\n\n你可以随时在设置中打开授权页面`)
                                ],
                                onConfirm: () => {
                                    balh_feature_sign.showLogin();
                                    document.querySelector('#AHP_Notice').remove()
                                }
                            })
                        }
                    })
                } else if ((isLogin() && Date.now() - parseInt(localStorage.oauthTime) > 24 * 60 * 60 * 1000) // 已登录，每天为周期检测key有效期，过期前五天会自动续期
                    || localStorage.balh_must_updateLoginFlag) {// 某些情况下，必须更新一次
                    updateLoginFlag(() => localStorage.balh_must_updateLoginFlag = r.const.FALSE);
                }
            }
            localStorage.balh_old_isLoginBiliBili = isLoginBiliBili() ? r.const.TRUE : r.const.FALSE
            localStorage.balh_pre_server = balh_config.server
        }

        function showLogin() {
            const balh_auth_window = window.open('about:blank');
            balh_auth_window.document.title = 'BALH - 授权';
            balh_auth_window.document.body.innerHTML = '<meta charset="UTF-8" name="viewport" content="width=device-width">正在获取授权，请稍候……';
            window.balh_auth_window = balh_auth_window;
            $.ajax('https://passport.bilibili.com/login/app/third?appkey=27eb53fc9058f8c3&api=https%3A%2F%2Fwww.mcbbs.net%2Ftemplate%2Fmcbbs%2Fimage%2Fspecial_photo_bg.png&sign=04224646d1fea004e79606d3b038c84a', {
                xhrFields: { withCredentials: true },
                type: 'GET',
                dataType: 'json',
                success: (data) => {
                    if (data.data.has_login) {
                        balh_auth_window.document.body.innerHTML = '<meta charset="UTF-8" name="viewport" content="width=device-width">正在跳转……';
                        balh_auth_window.location.href = data.data.confirm_uri;
                    } else {
                        balh_auth_window.close()
                        ui.alert('必须登录B站才能正常授权', () => {
                            location.href = 'https://passport.bilibili.com/login'
                        })
                    }
                },
                error: (e) => {
                    alert('error');
                }
            })
        }

        function showLoginByPassword() {
            const loginUrl = balh_config.server + '/login'
            ui.pop({
                content: `B站当前关闭了第三方登录的接口<br>目前只能使用帐号密码的方式<a href="${loginUrl}">登录代理服务器</a><br><br>登录完成后, 请手动刷新当前页面`,
                confirmBtn: '前往登录页面',
                onConfirm: () => {
                    window.open(loginUrl)
                }
            })
        }

        function showLogout() {
            ui.popFrame(balh_config.server + '/login?act=logout')
        }

        // 监听登录message
        window.addEventListener('message', function (e) {
            if (typeof e.data !== 'string') return // 只处理e.data为string的情况
            switch (e.data.split(':')[0]) {
                case 'BiliPlus-Login-Success': {
                    //登入
                    localStorage.balh_must_updateLoginFlag = r.const.TRUE
                    Promise.resolve('start')
                        .then(() => Async.jsonp(balh_config.server + '/login?act=getlevel'))
                        .then(() => location.reload())
                        .catch(() => location.reload())
                    break;
                }
                case 'BiliPlus-Logout-Success': {
                    //登出
                    clearLoginFlag()
                    location.reload()
                    break;
                }
                case 'balh-login-credentials': {
                    balh_auth_window.close();
                    let url = e.data.split(': ')[1];
                    const access_key = new URL(url).searchParams.get('access_key');
                    localStorage.access_key = access_key
                    ui.popFrame(url.replace('https://www.mcbbs.net/template/mcbbs/image/special_photo_bg.png', balh_config.server + '/login'));
                    break;
                }
            }
        })


        util_init(() => {
            if (!(util_page.player() || util_page.av())) {
                checkLoginState()
            }
        }, util_init.PRIORITY.DEFAULT, util_init.RUN_AT.DOM_LOADED_AFTER)
        return {
            showLogin,
            showLogout,
            isLogin,
            isLoginBiliBili,
        }
    }())
    const balh_feature_RedirectToBangumiOrInsertPlayer = (function () {
        // 重定向到Bangumi页面， 或者在当前页面直接插入播放页面
        function tryRedirectToBangumiOrInsertPlayer() {
            let $errorPanel;
            if (!($errorPanel = document.querySelector('.error-container > .error-panel'))) {
                return;
            }
            let msg = document.createElement('a');
            $errorPanel.insertBefore(msg, $errorPanel.firstChild);
            msg.innerText = '获取番剧页Url中...';
            let aid = (location.pathname.match('/\/video\/av(\d+)') || ['', ''])[1],
                page = (location.pathname.match(/\/index_(\d+).html/) || ['', '1'])[1],
                cid,
                season_id,
                episode_id;
            let avData;
            if (!aid) {
                let bv = (location.pathname.match(/\/video\/(BV\w+)/) || ['', ''])[1]
                if (bv) {
                    aid = Converters.bv2aid(bv)
                }
            }
            BiliPlusApi.view(aid)
                .then(function (data) {
                    avData = data;
                    if (data.code) {
                        return Promise.reject(JSON.stringify(data));
                    }
                    // 计算当前页面的cid
                    for (let i = 0; i < data.list.length; i++) {
                        if (data.list[i].page == page) {
                            cid = data.list[i].cid;
                            break;
                        }
                    }
                    if (!data.bangumi) {
                        generatePlayer(data, aid, page, cid)
                        // return Promise.reject('该AV号不属于任何番剧页');//No bangumi in api response
                    } else {
                        // 当前av属于番剧页面, 继续处理
                        season_id = data.bangumi.season_id;
                        return BiliPlusApi.season(season_id);
                    }
                })
                .then(function (result) {
                    if (result === undefined) return // 上一个then不返回内容时, 不需要处理
                    if (result.code === 10) { // av属于番剧页面, 通过接口却未能找到番剧信息
                        let ep_id_newest = avData && avData.bangumi && avData.bangumi.newest_ep_id
                        if (ep_id_newest) {
                            episode_id = ep_id_newest // 此时, 若avData中有最新的ep_id, 则直接使用它
                        } else {
                            log(`av${aid}属于番剧${season_id}, 但却不能找到番剧页的信息, 试图直接创建播放器`)
                            generatePlayer(avData, aid, page, cid)
                            return
                        }
                    } else if (result.code) {
                        return Promise.reject(JSON.stringify(result))
                    } else {
                        let ep_id_by_cid, ep_id_by_aid_page, ep_id_by_aid,
                            episodes = result.result.episodes,
                            ep
                        // 为何要用三种不同方式匹配, 详见: https://greasyfork.org/zh-CN/forum/discussion/22379/x#Comment_34127
                        for (let i = 0; i < episodes.length; i++) {
                            ep = episodes[i]
                            if (ep.danmaku == cid) {
                                ep_id_by_cid = ep.episode_id
                            }
                            if (ep.av_id == aid && ep.page == page) {
                                ep_id_by_aid_page = ep.episode_id
                            }
                            if (ep.av_id == aid) {
                                ep_id_by_aid = ep.episode_id
                            }
                        }
                        episode_id = ep_id_by_cid || ep_id_by_aid_page || ep_id_by_aid
                    }
                    if (episode_id) {
                        let bangumi_url = `//www.bilibili.com/bangumi/play/ss${season_id}#${episode_id}`
                        log('Redirect', 'aid:', aid, 'page:', page, 'cid:', cid, '==>', bangumi_url, 'season_id:', season_id, 'ep_id:', episode_id)
                        msg.innerText = '即将跳转到：' + bangumi_url
                        location.href = bangumi_url
                    } else {
                        return Promise.reject('查询episode_id失败')
                    }
                })
                .catch(function (e) {
                    log('error:', arguments);
                    msg.innerText = 'error:' + e;
                });
        }

        function generatePlayer(data, aid, page, cid) {
            let generateSrc = function (aid, cid) {
                return `//www.bilibili.com/blackboard/html5player.html?cid=${cid}&aid=${aid}&player_type=1`;
            }
            let generatePageList = function (pages) {
                let $curPage = null;
                function onPageBtnClick(e) {
                    e.target.className = 'curPage'
                    $curPage && ($curPage.className = '')

                    let index = e.target.attributes['data-index'].value;
                    iframe.src = generateSrc(aid, pages[index].cid);
                }

                return pages.map(function (item, index) {
                    let isCurPage = item.page == page
                    let $item = _('a', { 'data-index': index, className: isCurPage ? 'curPage' : '', event: { click: onPageBtnClick } }, [_('text', item.page + ': ' + item.part)])
                    if (isCurPage) $curPage = $item
                    return $item
                });
            }
            // 当前av不属于番剧页面, 直接在当前页面插入一个播放器的iframe
            let $pageBody = document.querySelector('.b-page-body');
            if (!$pageBody) { // 若不存在, 则创建
                $pageBody = _('div', { className: '.b-page-body' });
                document.querySelector('body').insertBefore($pageBody, document.querySelector('#app'))
                // 添加相关样式
                document.head.appendChild(_('link', { type: 'text/css', rel: 'stylesheet', href: '//static.hdslb.com/css/core-v5/page-core.css' }))
            }
            let iframe = _('iframe', { className: 'player bilibiliHtml5Player', style: { position: 'relative' }, src: generateSrc(aid, cid) });

            // 添加播放器
            $pageBody.appendChild(_('div', { className: 'player-wrapper' }, [
                _('div', { className: 'main-inner' }, [
                    _('div', { className: 'v-plist' }, [
                        _('div', { id: 'plist', className: 'plist-content open' }, generatePageList(data.list))
                    ])
                ]),
                _('div', { id: 'bofqi', className: 'scontent' }, [iframe])
            ]));
            // 添加评论区
            $pageBody.appendChild(_('div', { className: 'main-inner' }, [
                _('div', { className: 'common report-scroll-module report-wrap-module', id: 'common_report' }, [
                    _('div', { className: 'b-head' }, [
                        _('span', { className: 'b-head-t results' }),
                        _('span', { className: 'b-head-t' }, [_('text', '评论')]),
                        _('a', { className: 'del-log', href: `//www.bilibili.com/replydeletelog?aid=${aid}&title=${data.title}`, target: '_blank' }, [_('text', '查看删除日志')])
                    ]),
                    _('div', { className: 'comm', id: 'bbComment' }, [
                        _('div', { id: 'load_comment', className: 'comm_open_btn', onclick: "var fb = new bbFeedback('.comm', 'arc');fb.show(" + aid + ", 1);", style: { cursor: 'pointer' } })
                    ])
                ])
            ]));
            // 添加包含bbFeedback的js
            document.head.appendChild(_('script', { type: 'text/javascript', src: '//static.hdslb.com/js/core-v5/base.core.js' }))

            document.title = data.title;
            (document.querySelector('.error-body') || document.querySelector('.error-container')).remove(); // 移除错误信息面板
        }

        util_init(() => {
            if (util_page.av()) {
                tryRedirectToBangumiOrInsertPlayer()
            }
        }, util_init.PRIORITY.DEFAULT, util_init.RUN_AT.COMPLETE)
        return true // 随便返回一个值...
    }())
    const balh_feature_FillSeasonList = (function () {
        function tryFillSeasonList() {
            var error_container, season_id;
            if (!(error_container = document.querySelector('div.error-container'))) {
                return;
            }
            if (!(season_id = window.location.pathname.match(/^\/anime\/(\d+)\/?$/)[1])) {
                return;
            }

            //尝试解决怪异模式渲染
            /*
            会造成变量丢失，等待官方重写doctype
            try{
            window.stop();
                var xhr = new XMLHttpRequest();
            xhr.open('GET',location.href,false);
            xhr.send();
            document.head.appendChild(_('script',{},[_('text',
                'document.write(unescape("'+escape(xhr.response.replace(/<!DOCTYPE.+?>/,'<!DOCTYPE HTML>'))+'"));window.stop()'
            )]));
            }catch(e){util_error(e);}
            */

            var msg = _('a', { href: '//bangumi.bilibili.com/anime/' + season_id + '/play', style: { fontSize: '20px' } }, [_('text', `【${GM_info.script.name}】尝试获取视频列表中...`)]),
                content = _('div');

            error_container.insertBefore(content, error_container.firstChild);
            content.appendChild(msg);
            log('season>:', season_id);
            BiliPlusApi.season(season_id)
                .then(function (data) {
                    log('season>then:', data);
                    if (data.code) {
                        return Promise.reject(data);
                    }

                    function generateEpisodeList(episodes) {
                        var children = [];
                        episodes.reverse().forEach(function (i) {
                            children.push(_('li', { className: 'v1-bangumi-list-part-child', 'data-episode-id': i.episode_id }, [_('a', { className: 'v1-complete-text', href: '//bangumi.bilibili.com/anime/' + season_id + '/play#' + i.episode_id, title: i.index + ' ' + i.index_title, target: '_blank', style: { height: '60px' } }, [
                                _('div', { className: 'img-wrp' }, [_('img', { src: i.cover, style: { opacity: 1 }, loaded: 'loaded', alt: i.index + ' ' + i.index_title })]),
                                _('div', { className: 'text-wrp' }, [
                                    _('div', { className: 'text-wrp-num' }, [_('div', { className: 'text-wrp-num-content' }, [_('text', `第${i.index}话`)])]),
                                    _('div', { className: 'text-wrp-title trunc' }, [_('text', i.index_title)])
                                ])
                            ])]));
                        });
                        return children;
                    }

                    function generateSeasonList(seasons) {
                        function onSeasonClick(event) {
                            window.location.href = '//bangumi.bilibili.com/anime/' + event.target.attributes['data-season-id'].value;
                        }

                        return seasons.map(function (season) {
                            return _('li', { className: season.season_id == season_id ? 'cur' : '', 'data-season-id': season.season_id, event: { click: onSeasonClick } }, [_('text', season.title)]);
                        });
                    }

                    if (data.result) {
                        document.title = data.result.title;
                        document.head.appendChild(_('link', { href: 'https://s3.hdslb.com/bfs/static/anime/css/tag-index.css?v=110', rel: 'stylesheet' }));
                        document.head.appendChild(_('link', { href: 'https://s1.hdslb.com/bfs/static/anime/css/bangumi-index.css?v=110', rel: 'stylesheet' }));
                        document.body.insertBefore(_('div', { className: 'main-container-wrapper' }, [_('div', { className: 'main-container' }, [
                            _('div', { className: 'page-info-wrp' }, [_('div', { className: 'bangumi-info-wrapper' }, [
                                _('div', { className: 'bangumi-info-blurbg-wrapper' }, [_('div', { className: 'bangumi-info-blurbg blur', style: { backgroundImage: 'url(' + data.result.cover + ')' } })]),
                                _('div', { className: 'main-inner' }, [_('div', { className: 'info-content' }, [
                                    _('div', { className: 'bangumi-preview' }, [_('img', { alt: data.result.title, src: data.result.cover })]),
                                    _('div', { className: 'bangumi-info-r' }, [
                                        _('div', { className: 'b-head' }, [_('h1', { className: 'info-title', 'data-seasonid': season_id, title: data.result.title }, [_('text', data.result.title)])]),
                                        _('div', { className: 'info-count' }, [
                                            _('span', { className: 'info-count-item info-count-item-play' }, [_('span', { className: 'info-label' }, [_('text', '总播放')]), _('em', {}, [_('text', data.result.play_count)])]),
                                            _('span', { className: 'info-count-item info-count-item-fans' }, [_('span', { className: 'info-label' }, [_('text', '追番人数')]), _('em', {}, [_('text', data.result.favorites)])]),
                                            _('span', { className: 'info-count-item info-count-item-review' }, [_('span', { className: 'info-label' }, [_('text', '弹幕总数')]), _('em', {}, [_('text', data.result.danmaku_count)])])
                                        ]),
                                        //_('div',{className:'info-row info-update'},[]),
                                        //_('div',{className:'info-row info-cv'},[]),
                                        _('div', { className: 'info-row info-desc-wrp' }, [
                                            _('div', { className: 'info-row-label' }, [_('text', '简介：')]),
                                            _('div', { className: 'info-desc' }, [_('text', data.result.evaluate)])
                                        ]),
                                    ])
                                ])])
                            ])]),
                            _('div', { className: 'main-inner' }, [_('div', { className: 'v1-bangumi-list-wrapper clearfix' }, [
                                _('div', { className: 'v1-bangumi-list-season-wrapper' }, [
                                    _('div', { className: 'v1-bangumi-list-season-content slider-list-content' }, [
                                        _('div', {}, [
                                            _('ul', { className: 'v1-bangumi-list-season clearfix slider-list', 'data-current-season-id': season_id, style: { opacity: 1 } }, generateSeasonList(data.result.seasons))
                                        ])
                                    ])
                                ]),
                                _('div', { className: 'v1-bangumi-list-part-wrapper slider-part-wrapper' }, [_('div', { className: 'v1-bangumi-list-part clearfix', 'data-current-season-id': season_id, style: { display: 'block' } }, [
                                    _('div', { className: 'complete-list', style: { display: 'block' } }, [_('div', { className: 'video-slider-list-wrapper' }, [_('div', { className: 'slider-part-wrapper' }, [_('ul', { className: 'slider-part clearfix hide', style: { display: 'block' } }, generateEpisodeList(data.result.episodes))])])])
                                ])])
                            ])])
                        ])]), msg.parentNode.parentNode);
                        msg.parentNode.parentNode.remove();
                    }
                })
                .catch(function (error) {
                    log('season>catch', error);
                    msg.innerText = 'error:' + JSON.stringify(error) + '\n点击跳转到播放界面 (不一定能够正常播放...)';
                });
        }

        util_init(() => {
            if (util_page.bangumi()) {
                tryFillSeasonList()
            }
        })
        return true
    }())

    const balh_ui_setting = (function () {
        function addSettingsButton() {
            let indexNav = document.querySelector('.bangumi-nav-right, #index_nav, #fixnav_report')
            let settingBtnSvgContainer
            const createBtnStyle = (size, diffCss) => {
                diffCss = diffCss || `
                    #balh-settings-btn {
                        bottom: 110px;
                        border: 1px solid #e5e9ef;
                        border-radius: 4px;
                        background: #f6f9fa;
                        margin-top: 4px;
                    }
                    #balh-settings-btn .btn-gotop {
                        text-align: center;
                    }
                `
                return _('style', {}, [_('text', `
                    ${diffCss}
                    #balh-settings-btn {
                        width: ${size};
                        height: ${size};
                        cursor: pointer;
                    }
                    #balh-settings-btn:hover {
                        background: #00a1d6;
                        border-color: #00a1d6;
                    }
                    #balh-settings-btn .icon-saturn {
                        width: 30px;
                        height: ${size};
                        fill: rgb(153,162,170);
                    }
                    #balh-settings-btn:hover .icon-saturn {
                        fill: white;
                    }
            `)])
            }
            if (indexNav == null) {
                // 信息页添加到按钮右侧
                if (util_page.bangumi_md()) {
                    indexNav = document.querySelector('.media-info-btns');
                    indexNav.appendChild(createBtnStyle('44px', `
                        #balh-settings-btn {
                            float: left;
                            margin: 3px 0 0 20px;
                            background: #FFF;
                            border-radius: 10px;
                        }
                        #balh-settings-btn>:first-child {
                            text-align: center;
                            height: 100%;
                        }
                    `))
                } else {
                    // 新版视频页面的“返回页面顶部”按钮, 由Vue控制, 对内部html的修改会被重置, 故只能重新创建新的indexNav
                    let navTools = document.querySelector('.nav-tools, .float-nav')
                    if (navTools) {
                        let bottom = navTools.className.includes('float-nav') ? '53px' : '45px'
                        indexNav = document.body.appendChild(_('div', { style: { position: 'fixed', right: '6px', bottom: bottom, zIndex: '129', textAlign: 'center', display: 'none' } }))
                        indexNav.appendChild(createBtnStyle('45px'))
                        window.addEventListener('scroll', (event) => {
                            indexNav.style.display = window.scrollY < 600 ? 'none' : ''
                        })
                    }
                }
                if (indexNav) {
                    settingBtnSvgContainer = indexNav.appendChild(_('div', { id: 'balh-settings-btn', title: GM_info.script.name + ' 设置', event: { click: showSettings } }, [_('div', {})])).firstChild;
                }
            } else {
                // 视频页添加到回顶部下方
                window.dispatchEvent(new Event('resize'));
                indexNav.style.display = 'block';
                indexNav.appendChild(createBtnStyle('46px'))
                settingBtnSvgContainer = indexNav.appendChild(_('div', { id: 'balh-settings-btn', title: GM_info.script.name + ' 设置', event: { click: showSettings } }, [_('div', { className: 'btn-gotop' })])).firstChild;
            }
            settingBtnSvgContainer && (settingBtnSvgContainer.innerHTML = `<!-- https://www.flaticon.com/free-icon/saturn_53515 --><svg class="icon-saturn" viewBox="0 0 612.017 612.017"><path d="M596.275,15.708C561.978-18.59,478.268,5.149,380.364,68.696c-23.51-7.384-48.473-11.382-74.375-11.382c-137.118,0-248.679,111.562-248.679,248.679c0,25.902,3.998,50.865,11.382,74.375C5.145,478.253-18.575,561.981,15.724,596.279c34.318,34.318,118.084,10.655,216.045-52.949c23.453,7.365,48.378,11.344,74.241,11.344c137.137,0,248.679-111.562,248.679-248.68c0-25.862-3.979-50.769-11.324-74.24C606.931,133.793,630.574,50.026,596.275,15.708zM66.435,545.53c-18.345-18.345-7.919-61.845,23.338-117.147c22.266,39.177,54.824,71.716,94.02,93.943C128.337,553.717,84.837,563.933,66.435,545.53z M114.698,305.994c0-105.478,85.813-191.292,191.292-191.292c82.524,0,152.766,52.605,179.566,125.965c-29.918,41.816-68.214,87.057-113.015,131.839c-44.801,44.819-90.061,83.116-131.877,113.034C167.303,458.76,114.698,388.479,114.698,305.994z M305.99,497.286c-3.156,0-6.236-0.325-9.354-0.459c35.064-27.432,70.894-58.822,106.11-94.059c35.235-35.235,66.646-71.046,94.058-106.129c0.153,3.118,0.479,6.198,0.479,9.354C497.282,411.473,411.469,497.286,305.99,497.286z M428.379,89.777c55.303-31.238,98.803-41.683,117.147-23.338c18.402,18.383,8.187,61.902-23.204,117.377C500.095,144.62,467.574,112.043,428.379,89.777z"/></svg>`);
        }

        function _showSettings() {
            document.body.appendChild(settingsDOM);
            var form = settingsDOM.querySelector('form');
            // elements包含index的属性, 和以name命名的属性, 其中以name命名的属性是不可枚举的, 只能通过这种方式获取出来
            Object.getOwnPropertyNames(form.elements).forEach(function (name) {
                if (name.startsWith('balh_')) {
                    var key = name.replace('balh_', '')
                    var ele = form.elements[name]
                    if (ele.type === 'checkbox') {
                        ele.checked = balh_config[key];
                    } else {
                        ele.value = balh_config[key];
                    }
                }
            })
            document.body.style.overflow = 'hidden';
        }

        // 往顶层窗口发显示设置的请求
        function showSettings() {
            window.top.postMessage('balh-show-setting', '*')
        }

        // 只有顶层窗口才接收请求
        if (window === window.top) {
            window.addEventListener('message', (event) => {
                if (event.data === 'balh-show-setting') {
                    _showSettings();
                    $('#upos-server')[0].value = balh_config.upos_server || '';
                }
            })
        }

        function onSignClick(event) {
            settingsDOM.click();
            switch (event.target.attributes['data-sign'].value) {
                default:
                case 'in':
                    balh_feature_sign.showLogin();
                    break;
                case 'out':
                    balh_feature_sign.showLogout();
                    break;
            }
        }

        function onSettingsFormChange(e) {
            var name = e.target.name;
            var value = e.target.type === 'checkbox' ? (e.target.checked ? r.const.TRUE : r.const.FALSE) : e.target.value.trim()
            balh_config[name.replace('balh_', '')] = value
            log(name, ' => ', value);
        }

        // 第一次点击时:
        // 1. '复制日志&问题反馈' => '复制日志'
        // 2. 显示'问题反馈'
        // 3. 复制成功后请求跳转到GitHub
        // 之后的点击, 只是正常的复制功能~~
        function onCopyClick(event) {
            let issueLink = document.getElementById('balh-issue-link')
            let continueToIssue = issueLink.style.display === 'none'
            if (continueToIssue) {
                issueLink.style.display = 'inline'
                let copyBtn = document.getElementById('balh-copy-log')
                copyBtn.innerText = '复制日志'
            }

            let textarea = document.getElementById('balh-textarea-copy')
            textarea.style.display = 'inline-block'
            if (ui.copy(logHub.getAllMsg(), textarea)) {
                textarea.style.display = 'none'
                util_ui_msg.show($(this),
                    continueToIssue ? '复制日志成功; 点击确定, 继续提交问题(需要GitHub帐号)\n请把日志粘贴到问题描述中' : '复制成功',
                    continueToIssue ? 0 : 3e3,
                    continueToIssue ? 'button' : undefined,
                    continueToIssue ? openIssuePage : undefined)
            } else {
                util_ui_msg.show($(this), '复制失败, 请从下面的文本框手动复制', 5e3)
            }
        }

        function openIssuePage() {
            // window.open(r.url.issue)
            window.open(r.url.readme)
        }

        let printSystemInfoOk = false

        // 鼠标移入设置底部的时候, 打印一些系统信息, 方便问题反馈
        function onMouseEnterSettingBottom(event) {
            if (!printSystemInfoOk) {
                printSystemInfoOk = true
                util_debug('userAgent', navigator.userAgent)
            }
        }

        let customServerCheckText
        var settingsDOM = _('div', { id: 'balh-settings', style: { position: 'fixed', top: 0, bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,.7)', animationName: 'balh-settings-bg', animationDuration: '.5s', zIndex: 10000, cursor: 'pointer' }, event: { click: function (e) { if (e.target === this) util_ui_msg.close(), document.body.style.overflow = '', this.remove(); } } }, [
            _('style', {}, [_('text', r.css.settings)]),
            _('div', { style: { position: 'absolute', background: '#FFF', borderRadius: '10px', padding: '20px', top: '50%', left: '50%', width: '600px', transform: 'translate(-50%,-50%)', cursor: 'default' } }, [
                _('h1', {}, [_('text', `${GM_info.script.name} v${GM_info.script.version} 参数设置`)]),
                _('br'),
                _('form', { id: 'balh-settings-form', event: { change: onSettingsFormChange } }, [
                    _('text', '代理服务器：'), _('a', { href: 'javascript:', event: { click: balh_feature_runPing } }, [_('text', '测速')]), _('br'),
                    _('div', { style: { display: 'flex' } }, [
                        _('label', { style: { flex: 1 } }, [_('input', { type: 'radio', name: 'balh_server_inner', value: r.const.server.S0 }), _('text', '土豆服')]),
                        _('label', { style: { flex: 1 } }, [_('input', { type: 'radio', name: 'balh_server_inner', value: r.const.server.S1 }), _('text', 'BiliPlus')]),
                        _('label', { style: { flex: 2 } }, [
                            _('input', { type: 'radio', name: 'balh_server_inner', value: r.const.server.CUSTOM }), _('text', `自定义: `),
                            _('input', {
                                type: 'text', name: 'balh_server_custom', placeholder: '形如：https://hd.pilipili.com', event: {
                                    input: (event) => {
                                        customServerCheckText.innerText = /^https?:\/\/[\w.]+$/.test(event.target.value.trim()) ? '✔️' : '❌'
                                        onSettingsFormChange(event)
                                    }
                                }
                            }),
                            customServerCheckText = _('span'),
                        ]),
                    ]), _('br'),
                    _('div', { id: 'balh_server_ping', style: { whiteSpace: 'pre-wrap', overflow: 'auto' } }, []),
                    _('div', { style: { display: '' } }, [ // 这个功能貌似没作用了...隐藏掉 => 貌似还有用...重新显示
                        _('text', 'upos服务器：'), _('br'),
                        _('div', { title: '变更后 切换清晰度 或 刷新 生效' }, [
                            _('input', { style: { visibility: 'hidden' }, type: 'checkbox' }),
                            _('text', '替换upos视频服务器：'),
                            _('select', {
                                id: 'upos-server',
                                event: {
                                    change: function () {
                                        let server = this.value;
                                        let message = $('#upos-server-message');
                                        let clearMsg = function () { message.text('') }
                                        message.text('保存中...')
                                        $.ajax(balh_config.server + '/api/setUposServer?server=' + server, {
                                            xhrFields: { withCredentials: true },
                                            dataType: 'json',
                                            success: function (json) {
                                                if (json.code == 0) {
                                                    message.text('已保存');
                                                    setTimeout(clearMsg, 3e3);
                                                    balh_config.upos_server = server;
                                                }
                                            },
                                            error: function () {
                                                message.text('保存出错');
                                                setTimeout(clearMsg, 3e3);
                                            }
                                        })
                                    }
                                }
                            }, [
                                _('option', { value: "" }, [_('text', '不替换')]),
                                _('option', { value: "ks3u" }, [_('text', 'ks3（金山）')]),
                                _('option', { value: "kodou" }, [_('text', 'kodo（七牛）')]),
                                _('option', { value: "cosu" }, [_('text', 'cos（腾讯）')]),
                                _('option', { value: "bosu" }, [_('text', 'bos（百度）')]),
                                _('option', { value: "wcsu" }, [_('text', 'wcs（网宿）')]),
                                _('option', { value: "xycdn" }, [_('text', 'xycdn（迅雷）')]),
                                _('option', { value: "hw" }, [_('text', 'hw（251）')]),
                            ]),
                            _('span', { 'id': 'upos-server-message' })
                        ]), _('br'),
                    ]),
                    _('text', '脚本工作模式：'), _('br'),
                    _('div', { style: { display: 'flex' } }, [
                        _('label', { style: { flex: 1 } }, [_('input', { type: 'radio', name: 'balh_mode', value: r.const.mode.DEFAULT }), _('text', '默认：自动判断')]),
                        _('label', { style: { flex: 1 } }, [_('input', { type: 'radio', name: 'balh_mode', value: r.const.mode.REPLACE }), _('text', '替换：在需要时处理番剧')]),
                        _('label', { style: { flex: 1 } }, [_('input', { type: 'radio', name: 'balh_mode', value: r.const.mode.REDIRECT }), _('text', '重定向：完全代理所有番剧')])
                    ]), _('br'),
                    _('text', '其他：'), _('br'),
                    _('div', { style: { display: 'flex' } }, [
                        _('label', { style: { flex: 1 } }, [_('input', { type: 'checkbox', name: 'balh_blocked_vip' }), _('text', '被永封的大会员'), _('a', { href: 'https://github.com/ipcjs/bilibili-helper/blob/user.js/packages/unblock-area-limit/README.md#大会员账号被b站永封了', target: '_blank' }, [_('text', '(？)')])]),
                        _('label', { style: { flex: 1 } }, [_('input', { type: 'checkbox', name: 'balh_enable_in_av' }), _('text', '在AV页面启用'), _('a', { href: 'https://github.com/ipcjs/bilibili-helper/issues/172', target: '_blank' }, [_('text', '(？)')])]),
                        _('div', { style: { flex: 1, display: 'flex' } }, [
                            _('label', { style: { flex: 1 } }, [_('input', { type: 'checkbox', name: 'balh_remove_pre_ad' }), _('text', '去前置广告')]),
                            // _('label', { style: { flex: 1 } }, [_('input', { type: 'checkbox', name: 'balh_flv_prefer_ws' }), _('text', '优先使用ws')]),
                        ])
                    ]), _('br'),
                    _('a', { href: 'javascript:', 'data-sign': 'in', event: { click: onSignClick } }, [_('text', '帐号授权')]),
                    _('text', '　'),
                    _('a', { href: 'javascript:', 'data-sign': 'out', event: { click: onSignClick } }, [_('text', '取消授权')]),
                    _('text', '　　'),
                    _('a', { href: 'javascript:', event: { click: function () { util_ui_msg.show($(this), '如果你的帐号进行了付费，不论是大会员还是承包，\n进行授权之后将可以在解除限制时正常享有这些权益\n\n你可以随时在这里授权或取消授权\n\n不进行授权不会影响脚本的正常使用，但可能会缺失1080P', 1e4); } } }, [_('text', '（这是什么？）')]),
                    _('br'), _('br'),
                    _('div', { style: { whiteSpace: 'pre-wrap' }, event: { mouseenter: onMouseEnterSettingBottom } }, [
                        _('a', { href: 'https://greasyfork.org/zh-CN/scripts/25718-%E8%A7%A3%E9%99%A4b%E7%AB%99%E5%8C%BA%E5%9F%9F%E9%99%90%E5%88%B6', target: '_blank' }, [_('text', '脚本主页')]),
                        _('text', '　'),
                        _('a', { href: 'https://github.com/ipcjs/bilibili-helper/blob/user.js/packages/unblock-area-limit/README.md', target: '_blank' }, [_('text', '帮助说明')]),
                        _('text', '　'),
                        _('a', { id: 'balh-copy-log', href: 'javascript:;', event: { click: onCopyClick } }, [_('text', '复制日志&问题反馈')]),
                        _('text', '　'),
                        _('a', { id: 'balh-issue-link', href: 'javascript:;', event: { click: openIssuePage }, style: { display: 'none' } }, [_('text', '问题反馈')]),
                        _('a', { href: 'https://github.com/ipcjs/bilibili-helper/graphs/contributors' }, [_('text', '贡献者')]),
                        _('text', ' 接口：'),
                        _('a', { href: 'https://www.biliplus.com/' }, [_('text', 'BiliPlus ')]),
                        _('a', { href: 'https://github.com/kghost/bilibili-area-limit' }, [_('text', 'kghost ')]),
                        _('a', { href: 'https://github.com/yujincheng08/BiliRoaming' }, [_('text', 'BiliRoaming ')]),
                    ]),
                    _('textarea', { id: 'balh-textarea-copy', style: { display: 'none' } })
                ])
            ])
        ]);

        util_init(() => {
            if (!(util_page.player() || (util_page.av() && !balh_config.enable_in_av))) {
                addSettingsButton()
            }
        }, util_init.PRIORITY.DEFAULT, util_init.RUN_AT.DOM_LOADED_AFTER)
        return {
            dom: settingsDOM,
            show: showSettings,
        }
    }())

    bili.jump_to_baipiao()
    bili.biliplus_check_area_limit()

    function main() {
        util_info(
            'mode:', balh_config.mode,
            'blocked_vip:', balh_config.blocked_vip,
            'server:', balh_config.server,
            'upos_server:', balh_config.upos_server,
            'flv_prefer_ws:', balh_config.flv_prefer_ws,
            'remove_pre_ad:', balh_config.remove_pre_ad,
            'enable_in_av:', balh_config.enable_in_av,
            'readyState:', document.readyState,
            'isLogin:', balh_feature_sign.isLogin(),
            'isLoginBiliBili:', balh_feature_sign.isLoginBiliBili()
        )
        // 暴露接口
        window.bangumi_area_limit_hack = {
            setCookie: cookieStorage.set,
            getCookie: cookieStorage.get,
            login: balh_feature_sign.showLogin,
            logout: balh_feature_sign.showLogout,
            getLog: logHub.getAllMsg,
            showSettings: balh_ui_setting.show,
            set1080P: function () {
                const settings = JSON.parse(localStorage.bilibili_player_settings)
                const oldQuality = settings.setting_config.defquality
                util_debug(`defauality: ${oldQuality}`)
                settings.setting_config.defquality = 112 // 1080P
                localStorage.bilibili_player_settings = JSON.stringify(settings)
                location.reload()
            },
            _clear_local_value: function () {
                delete localStorage.oauthTime
                delete localStorage.balh_h5_not_first
                delete localStorage.balh_old_isLoginBiliBili
                delete localStorage.balh_must_remind_login_v3
                delete localStorage.balh_must_updateLoginFlag
            }
        }
    }

    main();
}

scriptContent();
