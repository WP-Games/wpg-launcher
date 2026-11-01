//! "What's New" — pulls the studio website's RSS feed (links.newsFeed in launcher.config.json)
//! so every game in the launcher shows the same site news.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    pub title: String,
    pub link: String,
    /// RFC 2822 date string as published (frontend formats it).
    pub date: String,
    pub summary: String,
}

pub async fn fetch_feed(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<NewsItem>, String> {
    let resp = client
        .get(url)
        .header("Accept", "application/rss+xml, application/xml, text/xml, */*")
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the news feed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("News feed returned {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    parse_feed(&bytes, url, limit)
}

pub fn parse_feed(bytes: &[u8], feed_url: &str, limit: usize) -> Result<Vec<NewsItem>, String> {
    let channel = rss::Channel::read_from(bytes).map_err(|e| format!("Couldn't read the news feed: {e}"))?;
    let base = url::Url::parse(feed_url).ok();
    let items = channel
        .items()
        .iter()
        .take(limit)
        .map(|it| {
            let raw_link = it.link().unwrap_or_default();
            // @astrojs/rss emits absolute links, but resolve relative ones too.
            let link = match (&base, url::Url::parse(raw_link)) {
                (_, Ok(u)) => u.to_string(),
                (Some(b), Err(_)) => b.join(raw_link).map(|u| u.to_string()).unwrap_or_default(),
                _ => raw_link.to_string(),
            };
            NewsItem {
                title: strip_html(it.title().unwrap_or("Untitled")),
                link,
                date: it.pub_date().unwrap_or_default().to_string(),
                summary: truncate(&strip_html(it.description().unwrap_or_default()), 220),
            }
        })
        .collect();
    Ok(items)
}

/// Good-enough HTML stripper for feed descriptions (tags removed, common
/// entities decoded, whitespace collapsed).
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    let cut = match cut.rfind(' ') {
        Some(i) if i > max / 2 => &cut[..i],
        _ => &cut,
    };
    format!("{}…", cut.trim_end_matches(|c: char| c == ',' || c == '.' || c == ';'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_astro_style_feed() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>White Phantom Games</title><link>https://whitephantomgames.co.uk/</link>
<description>d</description><language>en-gb</language>
<item><title>Version 1.7 Released</title><link>https://whitephantomgames.co.uk/news/v17-released/</link>
<guid>https://whitephantomgames.co.uk/news/v17-released/</guid>
<description>&lt;p&gt;A new full day &amp; ten new scenes.&lt;/p&gt;</description>
<pubDate>Sat, 01 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Relative</title><link>/news/rel/</link><description>x</description><pubDate>Fri, 31 Oct 2026 10:00:00 GMT</pubDate></item>
</channel></rss>"#;
        let items = parse_feed(xml.as_bytes(), "https://whitephantomgames.co.uk/rss.xml", 10).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Version 1.7 Released");
        assert_eq!(items[0].summary, "A new full day & ten new scenes.");
        assert_eq!(items[0].link, "https://whitephantomgames.co.uk/news/v17-released/");
        assert_eq!(items[1].link, "https://whitephantomgames.co.uk/news/rel/");
    }

    #[test]
    fn truncates_on_word_boundary() {
        let t = truncate("one two three four five six", 12);
        assert_eq!(t, "one two…");
    }
}
