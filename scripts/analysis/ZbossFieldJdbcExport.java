import java.sql.*;
import java.util.*;

public final class ZbossFieldJdbcExport {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("usage: <tenant-id> <output-file>");
        String url = required("ZBOSS_JDBC_URL");
        String user = required("ZBOSS_JDBC_USER");
        String password = required("ZBOSS_JDBC_PASSWORD");
        String tenantId = args[0];
        String output = args[1];
        String sql = """
            SELECT f.id, f.panel_id, f.field, f.field_tag_inner_key, f.field_format_tag,
                   f.union_field_tag,
                   GROUP_CONCAT(DISTINCT u.left_panel_field_id ORDER BY u.left_panel_field_id) left_ids,
                   GROUP_CONCAT(DISTINCT u.right_panel_field_id ORDER BY u.right_panel_field_id) right_ids
              FROM boss_view_dynamic_field_data f
              LEFT JOIN boss_view_dynamic_field_union_data u
                ON u.field_id = f.id AND u.tenant_id = f.tenant_id AND u.deleted = 0
             WHERE f.tenant_id = ? AND f.deleted = 0
             GROUP BY f.id, f.panel_id, f.field, f.field_tag_inner_key, f.field_format_tag, f.union_field_tag
             ORDER BY f.panel_id, f.field, f.id
            """;
        try (Connection connection = DriverManager.getConnection(url, user, password)) {
            connection.setReadOnly(true);
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                statement.setString(1, tenantId);
                try (ResultSet rows = statement.executeQuery();
                     java.io.BufferedWriter writer = java.nio.file.Files.newBufferedWriter(java.nio.file.Path.of(output))) {
                    while (rows.next()) {
                        writer.write(String.join("\t",
                            encoded(rows.getString(1)), encoded(rows.getString(2)), encoded(rows.getString(3)),
                            encoded(rows.getString(4)), encoded(rows.getString(5)), encoded(rows.getString(6)),
                            encoded(rows.getString(7)), encoded(rows.getString(8))));
                        writer.newLine();
                    }
                }
            }
        }
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) throw new IllegalStateException("missing " + name);
        return value;
    }

    private static String encoded(String value) {
        if (value == null) return "-";
        return Base64.getEncoder().encodeToString(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
