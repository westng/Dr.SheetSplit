use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek},
    path::Path,
};

use quick_xml::{events::Event, Reader};
use zip::ZipArchive;

#[derive(Clone)]
pub struct FallbackSheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

#[derive(Clone)]
pub struct FallbackWorkbook {
    pub sheets: Vec<FallbackSheet>,
}

fn local_name_matches(name: &[u8], expected: &[u8]) -> bool {
    name == expected || name.rsplit(|byte| *byte == b':').next() == Some(expected)
}

fn decode_attr_value(
    decoder: quick_xml::encoding::Decoder,
    attribute: &quick_xml::events::attributes::Attribute<'_>,
) -> Result<String, String> {
    attribute
        .decode_and_unescape_value(decoder)
        .map(|value| value.into_owned())
        .map_err(|error| error.to_string())
}

fn read_zip_entry<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> Result<Option<Vec<u8>>, String> {
    let mut file = match zip.by_name(name) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    Ok(Some(bytes))
}

fn normalize_workbook_target(target: &str) -> String {
    let normalized = target.replace('\\', "/");
    if normalized.starts_with("xl/") {
        return normalized;
    }
    if normalized.starts_with('/') {
        return normalized.trim_start_matches('/').to_string();
    }
    format!("xl/{normalized}")
}

fn column_index_from_cell_reference(cell_reference: &str) -> Option<usize> {
    let mut value = 0usize;
    let mut saw_letter = false;
    for ch in cell_reference.chars() {
        if ch.is_ascii_alphabetic() {
            saw_letter = true;
            value = value * 26 + (ch.to_ascii_uppercase() as usize - 'A' as usize + 1);
        } else {
            break;
        }
    }

    if saw_letter {
        Some(value.saturating_sub(1))
    } else {
        None
    }
}

fn parse_shared_strings(bytes: &[u8]) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_reader(bytes);
    let mut buffer = Vec::new();
    let mut shared_strings = Vec::new();
    let mut current = String::new();
    let mut in_si = false;
    let mut in_text = false;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let name = event.name().as_ref().to_vec();
                if local_name_matches(&name, b"si") {
                    in_si = true;
                    current.clear();
                } else if in_si && local_name_matches(&name, b"t") {
                    in_text = true;
                }
            }
            Ok(Event::End(event)) => {
                let name = event.name().as_ref().to_vec();
                if local_name_matches(&name, b"t") {
                    in_text = false;
                } else if local_name_matches(&name, b"si") {
                    shared_strings.push(current.clone());
                    current.clear();
                    in_si = false;
                }
            }
            Ok(Event::Text(event)) => {
                if in_text {
                    current.push_str(&event.xml_content().map_err(|error| error.to_string())?);
                }
            }
            Ok(Event::CData(event)) => {
                if in_text {
                    current.push_str(&event.xml_content().map_err(|error| error.to_string())?);
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buffer.clear();
    }

    Ok(shared_strings)
}

fn parse_workbook_relationships(bytes: &[u8]) -> Result<HashMap<String, String>, String> {
    let mut reader = Reader::from_reader(bytes);
    let mut buffer = Vec::new();
    let mut relationships = HashMap::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) => {
                if !local_name_matches(event.name().as_ref(), b"Relationship") {
                    buffer.clear();
                    continue;
                }

                let mut id = String::new();
                let mut target = String::new();
                for attribute in event.attributes().flatten() {
                    let key = attribute.key.as_ref();
                    if local_name_matches(key, b"Id") {
                        id = decode_attr_value(reader.decoder(), &attribute)?;
                    } else if local_name_matches(key, b"Target") {
                        target = decode_attr_value(reader.decoder(), &attribute)?;
                    }
                }

                if !id.is_empty() && !target.is_empty() {
                    relationships.insert(id, normalize_workbook_target(&target));
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buffer.clear();
    }

    Ok(relationships)
}

fn parse_workbook_sheets(
    bytes: &[u8],
    relationships: &HashMap<String, String>,
) -> Result<Vec<(String, String)>, String> {
    let mut reader = Reader::from_reader(bytes);
    let mut buffer = Vec::new();
    let mut sheets = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) => {
                if !local_name_matches(event.name().as_ref(), b"sheet") {
                    buffer.clear();
                    continue;
                }

                let mut name = String::new();
                let mut relationship_id = String::new();
                for attribute in event.attributes().flatten() {
                    let key = attribute.key.as_ref();
                    if local_name_matches(key, b"name") {
                        name = decode_attr_value(reader.decoder(), &attribute)?;
                    } else if local_name_matches(key, b"id") {
                        relationship_id = decode_attr_value(reader.decoder(), &attribute)?;
                    }
                }

                if let Some(target) = relationships.get(&relationship_id) {
                    sheets.push((name, target.clone()));
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buffer.clear();
    }

    Ok(sheets)
}

fn parse_sheet_rows(bytes: &[u8], shared_strings: &[String]) -> Result<Vec<Vec<String>>, String> {
    let mut reader = Reader::from_reader(bytes);
    let mut buffer = Vec::new();
    let mut rows = Vec::new();

    let mut current_row: Vec<String> = Vec::new();
    let mut current_col = 0usize;
    let mut current_type = String::new();
    let mut current_value = String::new();
    let mut in_row = false;
    let mut in_value = false;
    let mut in_inline_text = false;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let name = event.name().as_ref().to_vec();
                if local_name_matches(&name, b"row") {
                    current_row.clear();
                    in_row = true;
                } else if in_row && local_name_matches(&name, b"c") {
                    current_type.clear();
                    current_value.clear();
                    current_col = current_row.len();

                    for attribute in event.attributes().flatten() {
                        let key = attribute.key.as_ref();
                        if local_name_matches(key, b"t") {
                            current_type = decode_attr_value(reader.decoder(), &attribute)?;
                        } else if local_name_matches(key, b"r") {
                            let reference = decode_attr_value(reader.decoder(), &attribute)?;
                            if let Some(index) = column_index_from_cell_reference(&reference) {
                                current_col = index;
                            }
                        }
                    }
                } else if in_row && local_name_matches(&name, b"v") {
                    in_value = true;
                    current_value.clear();
                } else if in_row && local_name_matches(&name, b"t") {
                    in_inline_text = true;
                }
            }
            Ok(Event::End(event)) => {
                let name = event.name().as_ref().to_vec();
                if local_name_matches(&name, b"v") {
                    in_value = false;
                } else if local_name_matches(&name, b"t") {
                    in_inline_text = false;
                } else if local_name_matches(&name, b"c") {
                    if current_row.len() <= current_col {
                        current_row.resize(current_col + 1, String::new());
                    }

                    let normalized = match current_type.as_str() {
                        "s" => current_value
                            .parse::<usize>()
                            .ok()
                            .and_then(|index| shared_strings.get(index))
                            .cloned()
                            .unwrap_or_default(),
                        "b" => {
                            if current_value.trim() == "1" {
                                "true".to_string()
                            } else {
                                "false".to_string()
                            }
                        }
                        _ => current_value.trim().to_string(),
                    };

                    current_row[current_col] = normalized;
                } else if local_name_matches(&name, b"row") {
                    if current_row.iter().any(|value| !value.trim().is_empty()) {
                        rows.push(current_row.clone());
                    }
                    current_row.clear();
                    in_row = false;
                }
            }
            Ok(Event::Text(event)) => {
                if in_value || in_inline_text {
                    current_value.push_str(&event.xml_content().map_err(|error| error.to_string())?);
                }
            }
            Ok(Event::CData(event)) => {
                if in_value || in_inline_text {
                    current_value.push_str(&event.xml_content().map_err(|error| error.to_string())?);
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buffer.clear();
    }

    Ok(rows)
}

fn parse_xlsx_workbook<R: Read + Seek>(reader: R) -> Result<FallbackWorkbook, String> {
    let mut zip = ZipArchive::new(reader).map_err(|error| error.to_string())?;

    let shared_strings = match read_zip_entry(&mut zip, "xl/sharedStrings.xml")? {
        Some(bytes) => parse_shared_strings(&bytes)?,
        None => Vec::new(),
    };

    let relationships_bytes = read_zip_entry(&mut zip, "xl/_rels/workbook.xml.rels")?
        .ok_or_else(|| "缺少 workbook 关系文件。".to_string())?;
    let workbook_bytes =
        read_zip_entry(&mut zip, "xl/workbook.xml")?.ok_or_else(|| "缺少 workbook 文件。".to_string())?;

    let relationships = parse_workbook_relationships(&relationships_bytes)?;
    let sheet_entries = parse_workbook_sheets(&workbook_bytes, &relationships)?;

    let mut sheets = Vec::with_capacity(sheet_entries.len());
    for (sheet_name, target) in sheet_entries {
        let sheet_bytes = read_zip_entry(&mut zip, &target)?
            .ok_or_else(|| format!("缺少工作表文件：{target}"))?;
        let rows = parse_sheet_rows(&sheet_bytes, &shared_strings)?;
        sheets.push(FallbackSheet { name: sheet_name, rows });
    }

    Ok(FallbackWorkbook { sheets })
}

pub fn read_xlsx_from_path(path: &Path) -> Result<FallbackWorkbook, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    parse_xlsx_workbook(file)
}
